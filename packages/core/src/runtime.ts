/**
 * Runtime — the long-lived host process.
 *
 * Owns shared infrastructure (bus, scheduler, logger, webhook server)
 * and manages modules through a registry. Modules are loaded/unloaded
 * independently without affecting each other.
 */

import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
	ActorConnector,
	LogEntry,
	Logger,
	LogPhase,
	ModuleStatus,
	OrgLoopConfig,
	OrgLoopEvent,
	RuntimeStatus,
	SourceConnector,
	Transform,
} from '@orgloop/sdk';
import { generateTraceId } from '@orgloop/sdk';
import type { AuditRecord, AuditTrailOptions } from './audit.js';
import { AuditTrail } from './audit.js';
import type { EventBus } from './bus.js';
import { InMemoryBus } from './bus.js';
import { ConnectorError, ModuleConflictError, ModuleNotFoundError } from './errors.js';
import type { EventHistoryOptions, EventHistoryQuery, EventRecord } from './event-history.js';
import { EventHistory } from './event-history.js';
import type { RuntimeControl } from './http.js';
import { DEFAULT_HTTP_PORT, WebhookServer } from './http.js';
import type { InboxManagerOptions } from './inbox.js';
import { InboxManager } from './inbox.js';
import { LoggerManager } from './logger.js';
import type { LoopCheckResult, LoopDetectorOptions } from './loop-detector.js';
import { LoopDetector } from './loop-detector.js';
import { MetricsServer } from './metrics.js';
import type { ModuleConfig } from './module-instance.js';
import { ModuleInstance } from './module-instance.js';
import type { OutputValidatorOptions } from './output-validator.js';
import { OutputValidator } from './output-validator.js';
import { ModuleRegistry } from './registry.js';
import type { DispatchResult } from './route-dispatcher.js';
import { RouteDispatcher } from './route-dispatcher.js';
import { matchRoutes } from './router.js';
import { buildRouteDetails, buildSourceDetails } from './runtime-accessors.js';
import type { CrashHandlerHandle, HeartbeatHandle } from './runtime-crash-handlers.js';
import { installCrashHandlers, startHeartbeat } from './runtime-crash-handlers.js';
import { Scheduler } from './scheduler.js';
import type { CheckpointStore } from './store.js';
import { FileCheckpointStore, InMemoryCheckpointStore } from './store.js';
import type { TransformPipelineOptions } from './transform.js';
import { executeTransformPipeline } from './transform.js';
export interface SourceCircuitBreakerOptions {
	failureThreshold?: number;
	retryAfterMs?: number;
}

export interface RouteStats {
	fireCount: number;
	lastFiredAt: string | null;
}

export interface RuntimeOptions {
	bus?: EventBus;
	loggerManager?: LoggerManager;
	httpPort?: number;
	circuitBreaker?: SourceCircuitBreakerOptions;
	dataDir?: string;
	crashHandlers?: boolean;
	heartbeat?: boolean;
	heartbeatIntervalMs?: number;
	metricsPort?: number;
	eventHistory?: EventHistoryOptions;
	auditTrail?: AuditTrailOptions;
	outputValidator?: OutputValidatorOptions;
	loopDetector?: LoopDetectorOptions;
	inbox?: InboxManagerOptions;
}

export interface LoadModuleOptions {
	sources?: Map<string, SourceConnector>;
	actors?: Map<string, ActorConnector>;
	transforms?: Map<string, Transform>;
	loggers?: Map<string, Logger>;
	checkpointStore?: CheckpointStore;
}
export interface SingleModuleOptions {
	runtime?: RuntimeOptions;
	load?: LoadModuleOptions;
	moduleName?: string;
}

const DEFAULT_SINGLE_MODULE_NAME = 'default';
class Runtime extends EventEmitter implements RuntimeControl {
	private readonly bus: EventBus;
	private readonly scheduler = new Scheduler();
	private readonly loggerManager: LoggerManager;
	private readonly registry = new ModuleRegistry();
	private readonly webhookServer: WebhookServer;
	private readonly routeDispatcher: RouteDispatcher;

	private running = false;
	private httpStarted = false;
	private startedAt = 0;
	private readonly httpPort: number;
	private readonly dataDir?: string;

	private readonly circuitBreakerOpts: Required<SourceCircuitBreakerOptions>;
	private readonly circuitRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

	private readonly moduleConfigs = new Map<string, ModuleConfig>();
	private readonly moduleLoadOptions = new Map<string, LoadModuleOptions>();

	private pendingSingleModule: { config: ModuleConfig; options: LoadModuleOptions } | null = null;

	private readonly pendingSourceIds = new Set<string>();

	private readonly sourceIdToModule = new Map<string, string>();

	private readonly enableCrashHandlers: boolean;
	private crashHandle: CrashHandlerHandle | null = null;

	private readonly enableHeartbeat: boolean;
	private readonly heartbeatIntervalMs: number;
	private heartbeatHandle: HeartbeatHandle | null = null;
	private readonly heartbeatDir = join(homedir(), '.orgloop');
	private readonly heartbeatFile = join(homedir(), '.orgloop', 'heartbeat');

	private readonly metricsServer: MetricsServer | null;
	private readonly metricsPort: number | undefined;

	private readonly eventHistory: EventHistory;
	private readonly routeStats = new Map<string, RouteStats>();

	private readonly auditTrail: AuditTrail;
	private readonly outputValidator: OutputValidator;
	private readonly loopDetector: LoopDetector;

	private readonly inboxManager: InboxManager | null;

	constructor(options?: RuntimeOptions) {
		super();
		this.bus = options?.bus ?? new InMemoryBus();
		this.loggerManager = options?.loggerManager ?? new LoggerManager();
		this.httpPort =
			options?.httpPort ??
			(process.env.ORGLOOP_PORT
				? Number.parseInt(process.env.ORGLOOP_PORT, 10)
				: DEFAULT_HTTP_PORT);
		this.dataDir = options?.dataDir;
		this.circuitBreakerOpts = {
			failureThreshold: options?.circuitBreaker?.failureThreshold ?? 5,
			retryAfterMs: options?.circuitBreaker?.retryAfterMs ?? 60_000,
		};
		this.webhookServer = new WebhookServer((event) => {
			const moduleName = this.resolveModuleForSource(event.source);
			return this.inject(event, moduleName);
		});
		this.enableCrashHandlers = options?.crashHandlers ?? true;
		this.enableHeartbeat = options?.heartbeat ?? !!process.env.ORGLOOP_DAEMON;
		this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 30_000;

		this.metricsPort = options?.metricsPort;
		const envPort = process.env.ORGLOOP_METRICS_PORT;
		if (this.metricsPort != null || envPort) {
			this.metricsServer = new MetricsServer();
		} else {
			this.metricsServer = null;
		}

		this.eventHistory = new EventHistory(options?.eventHistory);

		this.auditTrail = new AuditTrail(options?.auditTrail);
		this.outputValidator = new OutputValidator(options?.outputValidator);
		this.loopDetector = new LoopDetector(options?.loopDetector);

		this.inboxManager = options?.inbox !== undefined ? new InboxManager(options.inbox) : null;

		this.routeDispatcher = new RouteDispatcher({
			loggerManager: this.loggerManager,
			inboxManager: this.inboxManager,
			loopDetector: this.loopDetector,
			outputValidator: this.outputValidator,
			auditTrail: this.auditTrail,
			metricsServer: this.metricsServer,
			emit: (event, data) => this.emit(event, data),
		});
	}
	static singleModule(config: OrgLoopConfig, options?: SingleModuleOptions): Runtime {
		const runtimeOptions: RuntimeOptions = {
			...(options?.runtime ?? {}),
			dataDir: options?.runtime?.dataDir ?? config.data_dir,
		};
		const runtime = new Runtime(runtimeOptions);

		const moduleName = options?.moduleName ?? DEFAULT_SINGLE_MODULE_NAME;
		const moduleConfig: ModuleConfig = {
			name: moduleName,
			sources: config.sources,
			actors: config.actors,
			routes: config.routes,
			transforms: config.transforms,
			loggers: config.loggers,
			defaults: config.defaults,
		};

		runtime.pendingSingleModule = {
			config: moduleConfig,
			options: options?.load ?? {},
		};

		return runtime;
	}
	async start(): Promise<void> {
		if (this.running) return;

		if (this.enableCrashHandlers) {
			this.installCrashHandlers();
		}

		if (this.pendingSingleModule) {
			const pending = this.pendingSingleModule;
			this.pendingSingleModule = null;
			await this.loadModule(pending.config, pending.options);
		}

		this.scheduler.start((sourceId, moduleName) => this.pollSource(sourceId, moduleName));

		this.running = true;
		this.startedAt = Date.now();

		if (this.enableHeartbeat) {
			this.startHeartbeat();
		}

		if (this.metricsServer) {
			await this.metricsServer.start({ port: this.metricsPort });
		}

		await this.emitLog('runtime.start', { result: 'started' });
	}

	async startHttpServer(): Promise<void> {
		if (this.httpStarted) return;
		this.webhookServer.runtime = this;
		await this.webhookServer.start(this.httpPort);
		this.httpStarted = true;
	}

	isHttpStarted(): boolean {
		return this.httpStarted;
	}

	async stop(): Promise<void> {
		if (!this.running) return;

		await this.emitLog('runtime.stop', { result: 'stopping' });

		for (const mod of this.registry.list()) {
			try {
				mod.deactivate();
				this.scheduler.removeSources(mod.name);
				await mod.shutdown();
			} catch {}
		}

		if (this.httpStarted) {
			await this.webhookServer.stop();
			this.httpStarted = false;
		}

		this.scheduler.stop();

		for (const timer of this.circuitRetryTimers.values()) {
			clearTimeout(timer);
		}
		this.circuitRetryTimers.clear();

		this.stopHeartbeat();

		if (this.metricsServer?.isStarted()) {
			await this.metricsServer.stop();
		}

		if (this.inboxManager) {
			await this.inboxManager.close();
		}

		this.removeCrashHandlers();

		await this.loggerManager.flush();
		await this.loggerManager.shutdown();

		this.running = false;
	}
	async loadModule(config: ModuleConfig, options?: LoadModuleOptions): Promise<ModuleStatus> {
		if (this.registry.has(config.name)) {
			throw new ModuleConflictError(config.name, `Module "${config.name}" is already loaded`);
		}
		const incomingSourceIds = config.sources.map((s) => s.id);
		this.assertSourceIdsUnique(incomingSourceIds, config.name);
		for (const id of incomingSourceIds) {
			this.pendingSourceIds.add(id);
		}

		try {
			const checkpointStore = options?.checkpointStore ?? this.resolveCheckpointStore(config);

			const mod = new ModuleInstance(config, {
				sources: options?.sources ?? new Map(),
				actors: options?.actors ?? new Map(),
				transforms: options?.transforms ?? new Map(),
				loggers: options?.loggers ?? new Map(),
				checkpointStore,
			});

			await mod.initialize();

			mod.activate();
			this.registry.register(mod);

			for (const id of incomingSourceIds) {
				this.sourceIdToModule.set(id, config.name);
			}

			for (const [, logger] of mod.getLoggers()) {
				this.loggerManager.addLogger(logger, mod.name);
			}

			const defaultInterval = config.defaults?.poll_interval ?? '5m';
			let hasWebhooks = false;
			for (const srcCfg of config.sources) {
				const connector = mod.getSource(srcCfg.id);
				if (!connector) continue;

				if (typeof connector.webhook === 'function') {
					this.webhookServer.addHandler(srcCfg.id, connector.webhook());
					hasWebhooks = true;
				}
				const isWebhook = typeof connector.webhook === 'function';
				if (srcCfg.poll?.interval || !isWebhook) {
					const interval = srcCfg.poll?.interval ?? defaultInterval;
					this.scheduler.addSource(srcCfg.id, interval, mod.name);
				}
			}

			if (hasWebhooks && !this.httpStarted) {
				await this.startHttpServer();
			}

			this.metricsServer?.connectedSources.set(this.countAllSources());

			this.moduleConfigs.set(config.name, config);
			if (options) {
				this.moduleLoadOptions.set(config.name, options);
			}

			await this.emitLog('module.active', {
				result: `module "${config.name}" loaded`,
				module: config.name,
			});

			return mod.status();
		} finally {
			for (const id of incomingSourceIds) {
				this.pendingSourceIds.delete(id);
			}
		}
	}

	async unloadModule(name: string): Promise<void> {
		const mod = this.registry.get(name);
		if (!mod) {
			throw new ModuleNotFoundError(name);
		}

		await this.emitLog('module.unloading', {
			result: `unloading module "${name}"`,
			module: name,
		});

		mod.deactivate();

		this.scheduler.removeSources(name);

		for (const srcCfg of mod.config.sources) {
			this.webhookServer.removeHandler(srcCfg.id);
			this.sourceIdToModule.delete(srcCfg.id);
		}

		await mod.shutdown();

		this.loggerManager.removeLoggersByTag(name);

		this.registry.unregister(name);

		this.moduleConfigs.delete(name);
		this.moduleLoadOptions.delete(name);

		this.metricsServer?.connectedSources.set(this.countAllSources());

		await this.emitLog('module.removed', {
			result: `module "${name}" removed`,
			module: name,
		});
	}

	async reloadModule(name: string): Promise<void> {
		const config = this.moduleConfigs.get(name);
		if (!config) {
			throw new ModuleNotFoundError(name);
		}
		const options = this.moduleLoadOptions.get(name);

		await this.unloadModule(name);
		await this.loadModule(config, options);
	}
	private assertSourceIdsUnique(incoming: string[], moduleName: string): void {
		const seen = new Set<string>();
		for (const id of incoming) {
			if (seen.has(id)) {
				throw new ModuleConflictError(
					moduleName,
					`Module "${moduleName}" declares duplicate source id "${id}"`,
				);
			}
			seen.add(id);
		}

		for (const mod of this.registry.list()) {
			for (const src of mod.config.sources) {
				if (seen.has(src.id)) {
					throw new ModuleConflictError(
						moduleName,
						`Source id "${src.id}" already registered by module "${mod.name}"`,
					);
				}
			}
		}

		for (const id of incoming) {
			if (this.pendingSourceIds.has(id)) {
				throw new ModuleConflictError(
					moduleName,
					`Source id "${id}" is already being loaded by another module (concurrent load)`,
				);
			}
		}
	}
	private resolveModuleForSource(sourceId: string): string {
		const moduleName = this.sourceIdToModule.get(sourceId);
		if (!moduleName) {
			throw new ModuleNotFoundError(
				sourceId,
				`No module owns source "${sourceId}" — drop or wait for module to load`,
			);
		}
		return moduleName;
	}
	async inject(event: OrgLoopEvent, moduleName?: string): Promise<void> {
		const resolved = event.trace_id ? event : { ...event, trace_id: generateTraceId() };

		const target = this.resolveTargetModule(moduleName, 'inject');
		await this.processEvent(resolved, target);
	}
	private resolveTargetModule(
		moduleName: string | undefined,
		op: string,
	): import('./module-instance.js').ModuleInstance {
		if (moduleName) {
			const mod = this.registry.get(moduleName);
			if (!mod) {
				throw new ModuleNotFoundError(moduleName);
			}
			return mod;
		}
		const all = this.registry.list();
		if (all.length === 1) return all[0];
		throw new Error(`${op}: moduleName required: ${all.length} active modules`);
	}

	private async processEvent(
		event: OrgLoopEvent,
		mod: import('./module-instance.js').ModuleInstance,
	): Promise<void> {
		const eventStartTime = process.hrtime.bigint();
		this.emit('event', event);

		await this.emitLog('source.emit', {
			event_id: event.id,
			trace_id: event.trace_id,
			source: event.source,
			event_type: event.type,
			module: mod.name,
		});
		if (event.trace_id) {
			const loopCheck = this.loopDetector.check(
				event.trace_id,
				event.id,
				event.source,
				event.type,
				null,
				null,
			);

			if (loopCheck.circuit_broken) {
				await this.emitLog('loop.circuit_broken', {
					event_id: event.id,
					trace_id: event.trace_id,
					source: event.source,
					module: mod.name,
					result: `Circuit broken: event chain depth ${loopCheck.chain_depth} exceeds limit`,
					metadata: {
						chain_depth: loopCheck.chain_depth,
						chain: loopCheck.chain.map((n) => n.event_id),
					},
				});
				this.emit('loop:circuit_broken', { event, loopCheck });
				await this.bus.ack(event.id);
				return;
			}

			if (loopCheck.loop_detected) {
				await this.emitLog('loop.detected', {
					event_id: event.id,
					trace_id: event.trace_id,
					source: event.source,
					module: mod.name,
					result: `Loop detected: chain depth ${loopCheck.chain_depth}`,
					metadata: {
						chain_depth: loopCheck.chain_depth,
						flags: loopCheck.flags.map((f) => f.message),
					},
				});
				this.emit('loop:detected', { event, loopCheck });
			}
		}

		await this.bus.publish(event);

		const matched = matchRoutes(event, mod.getRoutes());

		if (matched.length === 0) {
			await this.emitLog('route.no_match', {
				event_id: event.id,
				trace_id: event.trace_id,
				source: event.source,
				module: mod.name,
			});

			this.eventHistory.push(this.buildEventRecord(event, mod.name, [], [], [], eventStartTime));
			await this.bus.ack(event.id);
			return;
		}

		const matchedRouteNames: string[] = [];
		const sopFiles: string[] = [];
		const actorIds: string[] = [];
		const now = new Date().toISOString();

		for (const match of matched) {
			const { route } = match;
			const routeStartTime = process.hrtime.bigint();

			matchedRouteNames.push(route.name);
			actorIds.push(route.then.actor);
			if (route.with?.prompt_file) {
				sopFiles.push(route.with.prompt_file);
			}

			const stats = this.routeStats.get(route.name);
			if (stats) {
				stats.fireCount++;
				stats.lastFiredAt = now;
			} else {
				this.routeStats.set(route.name, { fireCount: 1, lastFiredAt: now });
			}

			await this.emitLog('route.match', {
				event_id: event.id,
				trace_id: event.trace_id,
				route: route.name,
				source: event.source,
				target: route.then.actor,
				module: mod.name,
			});

			let transformedEvent = event;
			if (route.transforms && route.transforms.length > 0) {
				const pipelineOptions: TransformPipelineOptions = {
					definitions: mod.config.transforms,
					packageTransforms: mod.getTransformsMap(),
					onLog: (partial) => {
						void this.emitLog(partial.phase ?? 'transform.start', {
							...partial,
							event_id: partial.event_id ?? event.id,
							trace_id: partial.trace_id ?? event.trace_id,
							route: route.name,
							module: mod.name,
						});
					},
				};

				const context = {
					source: event.source,
					target: route.then.actor,
					eventType: event.type,
					routeName: route.name,
				};

				try {
					const result = await executeTransformPipeline(
						event,
						context,
						route.transforms,
						pipelineOptions,
					);

					if (result.dropped || !result.event) {
						this.recordRouteMetrics(route.name, route.then.actor, 'skipped', routeStartTime);
						continue;
					}
					transformedEvent = result.event;
				} catch (err) {
					this.emit('error', err as Error);
					this.recordRouteMetrics(route.name, route.then.actor, 'error', routeStartTime);
					continue;
				}
			}

			const dispatchResult: DispatchResult = await this.routeDispatcher.dispatch(
				transformedEvent,
				route,
				mod,
			);
			this.recordRouteMetrics(route.name, route.then.actor, dispatchResult.status, routeStartTime);
		}

		this.eventHistory.push(
			this.buildEventRecord(event, mod.name, matchedRouteNames, sopFiles, actorIds, eventStartTime),
		);

		await this.bus.ack(event.id);
	}

	private recordRouteMetrics(
		routeName: string,
		actor: string,
		status: DispatchResult['status'],
		startTime: bigint,
	): void {
		if (!this.metricsServer) return;
		const elapsed = Number(process.hrtime.bigint() - startTime) / 1e9;
		this.metricsServer.eventsRouted.inc({ route: routeName, connector: actor, status });
		this.metricsServer.eventProcessingSeconds.observe({ route: routeName, status }, elapsed);
	}

	private buildEventRecord(
		event: OrgLoopEvent,
		moduleName: string,
		matchedRouteNames: string[],
		sopFiles: string[],
		actorIds: string[],
		startTime: bigint,
	): EventRecord {
		const elapsedMs = Number(process.hrtime.bigint() - startTime) / 1e6;
		return {
			event_id: event.id,
			timestamp: event.timestamp,
			source: event.source,
			type: event.type,
			matched_routes: matchedRouteNames,
			sop_files: sopFiles,
			actors: actorIds,
			processing_ms: Math.round(elapsedMs * 100) / 100,
			module: moduleName,
			trace_id: event.trace_id,
		};
	}
	async pollSource(sourceId: string, moduleName?: string): Promise<void> {
		const mod = this.resolveTargetModule(moduleName, 'pollSource');
		if (mod.getState() !== 'active') return;

		const connector = mod.getSource(sourceId);
		if (!connector) return;

		const healthState = mod.getHealthState(sourceId);
		if (!healthState) return;

		if (healthState.circuitOpen) {
			return;
		}

		healthState.lastPollAttempt = new Date().toISOString();

		try {
			const store = mod.getCheckpointStore();
			const checkpoint = await store.get(sourceId);
			const result = await connector.poll(checkpoint);

			if (result.checkpoint) {
				await store.set(sourceId, result.checkpoint);
			}

			healthState.lastSuccessfulPoll = new Date().toISOString();
			healthState.lastError = null;
			healthState.totalEventsEmitted += result.events.length;

			if (healthState.consecutiveErrors > 0) {
				await this.emitLog('source.circuit_close', {
					source: sourceId,
					result: `recovered after ${healthState.consecutiveErrors} consecutive errors`,
					module: mod.name,
				});
			}

			healthState.consecutiveErrors = 0;
			healthState.status = 'healthy';

			for (const event of result.events) {
				const enriched = event.trace_id ? event : { ...event, trace_id: generateTraceId() };
				await this.processEvent(enriched, mod);
			}
		} catch (err) {
			const error = new ConnectorError(sourceId, 'Poll failed', { cause: err });
			this.emit('error', error);
			this.metricsServer?.connectorErrors.inc({ connector: sourceId });

			healthState.consecutiveErrors++;
			healthState.lastError = err instanceof Error ? err.message : String(err);

			if (healthState.consecutiveErrors >= this.circuitBreakerOpts.failureThreshold) {
				healthState.status = 'unhealthy';
				healthState.circuitOpen = true;

				await this.emitLog('source.circuit_open', {
					source: sourceId,
					error: healthState.lastError,
					result: `${healthState.consecutiveErrors} consecutive failures — polling paused, will retry in ${Math.round(this.circuitBreakerOpts.retryAfterMs / 1000)}s`,
					module: mod.name,
				});

				this.scheduleCircuitRetry(sourceId, mod.name);
			} else {
				healthState.status = 'degraded';
				await this.emitLog('system.error', {
					source: sourceId,
					error: error.message,
					module: mod.name,
				});
			}
		}
	}

	private scheduleCircuitRetry(sourceId: string, moduleName: string): void {
		const timerKey = `${moduleName}/${sourceId}`;
		const existing = this.circuitRetryTimers.get(timerKey);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(async () => {
			this.circuitRetryTimers.delete(timerKey);
			if (!this.running) return;

			const mod = this.registry.get(moduleName);
			if (!mod || mod.getState() !== 'active') return;

			const healthState = mod.getHealthState(sourceId);
			if (!healthState || !healthState.circuitOpen) return;

			await this.emitLog('source.circuit_retry', {
				source: sourceId,
				result: 'attempting recovery poll',
				module: moduleName,
			});

			healthState.circuitOpen = false;
			await this.pollSource(sourceId, moduleName);
		}, this.circuitBreakerOpts.retryAfterMs);

		this.circuitRetryTimers.set(timerKey, timer);
	}
	private resolveCheckpointStore(config: ModuleConfig): CheckpointStore {
		const cpConfig = config.defaults?.checkpoint;
		if (cpConfig?.store === 'memory') {
			return new InMemoryCheckpointStore();
		}
		if (cpConfig?.store === 'file' || cpConfig?.dir) {
			if (cpConfig?.dir) {
				const dir =
					cpConfig.dir.startsWith('/') || !config.modulePath
						? cpConfig.dir
						: join(config.modulePath, cpConfig.dir);
				return new FileCheckpointStore(dir);
			}
			if (config.modulePath) {
				return new FileCheckpointStore(join(config.modulePath, '.orgloop', 'checkpoints'));
			}
			return new FileCheckpointStore();
		}
		if (config.modulePath) {
			return new FileCheckpointStore(join(config.modulePath, '.orgloop', 'checkpoints'));
		}
		if (this.dataDir) {
			return new FileCheckpointStore(this.dataDir);
		}
		return new InMemoryCheckpointStore();
	}

	private countAllSources(): number {
		let count = 0;
		for (const mod of this.registry.list()) {
			count += mod.config.sources.length;
		}
		return count;
	}
	private installCrashHandlers(): void {
		if (this.crashHandle) return;
		this.crashHandle = installCrashHandlers({
			onError: (err) => this.emit('error', err),
			onLog: (message) => this.emitLog('system.error', { error: message }),
			stop: () => this.stop(),
		});
	}

	private removeCrashHandlers(): void {
		this.crashHandle?.uninstall();
		this.crashHandle = null;
	}

	private startHeartbeat(): void {
		if (this.heartbeatHandle) return;
		this.heartbeatHandle = startHeartbeat({
			dir: this.heartbeatDir,
			file: this.heartbeatFile,
			intervalMs: this.heartbeatIntervalMs,
			snapshot: () => ({
				pid: process.pid,
				uptime_ms: this.running ? Date.now() - this.startedAt : 0,
				modules: this.registry.list().length,
			}),
		});
	}

	private stopHeartbeat(): void {
		this.heartbeatHandle?.stop();
		this.heartbeatHandle = null;
	}
	registerControlHandler(
		route: string,
		handler: (body: Record<string, unknown>) => Promise<unknown>,
	): void {
		this.webhookServer.registerControlHandler(route, handler);
	}
	status(): RuntimeStatus {
		return {
			running: this.running,
			pid: process.pid,
			uptime_ms: this.running ? Date.now() - this.startedAt : 0,
			httpPort: this.httpPort,
			modules: this.registry.list().map((m) => m.status()),
		};
	}

	listModules(): ModuleStatus[] {
		return this.registry.list().map((m) => m.status());
	}

	getModuleStatus(name: string): ModuleStatus | undefined {
		const mod = this.registry.get(name);
		return mod?.status();
	}
	queryEvents(query?: EventHistoryQuery): EventRecord[] {
		return this.eventHistory.query(query);
	}

	getRouteStats(): ReadonlyMap<string, RouteStats> {
		return this.routeStats;
	}

	getRouteDetails() {
		return buildRouteDetails(this.registry.list(), this.routeStats);
	}

	getSourceDetails() {
		return buildSourceDetails(this.registry.list());
	}
	queryAuditTrail(filter?: {
		trace_id?: string;
		route?: string;
		actor?: string;
		held_only?: boolean;
		flagged_only?: boolean;
		limit?: number;
	}): AuditRecord[] {
		return this.auditTrail.query(filter);
	}

	getAuditChain(traceId: string): AuditRecord[] {
		return this.auditTrail.getChain(traceId);
	}

	getLoopState(traceId: string): LoopCheckResult | null {
		const chain = this.loopDetector.getChain(traceId);
		if (chain.length === 0) return null;
		return {
			loop_detected: false,
			circuit_broken: this.loopDetector.isCircuitBroken(traceId),
			chain_depth: chain.length,
			chain,
			flags: [],
		};
	}

	getAuditTrail(): AuditTrail {
		return this.auditTrail;
	}

	getLoopDetector(): LoopDetector {
		return this.loopDetector;
	}

	getOutputValidator(): OutputValidator {
		return this.outputValidator;
	}

	async getMetricsText(): Promise<string | null> {
		if (!this.metricsServer) return null;
		return this.metricsServer.metricsText();
	}

	getWebhookServer(): WebhookServer {
		return this.webhookServer;
	}

	getInboxManager(): InboxManager | null {
		return this.inboxManager;
	}
	private async emitLog(
		phase: LogPhase,
		fields: Partial<LogEntry> & { module?: string },
	): Promise<void> {
		const entry: LogEntry = {
			timestamp: new Date().toISOString(),
			event_id: fields.event_id ?? '',
			trace_id: fields.trace_id ?? '',
			phase,
			source: fields.source,
			target: fields.target,
			route: fields.route,
			transform: fields.transform,
			event_type: fields.event_type,
			result: fields.result,
			duration_ms: fields.duration_ms,
			error: fields.error,
			metadata: fields.metadata,
			module: fields.module,
		};

		await this.loggerManager.log(entry);
	}
}

export { Runtime };
