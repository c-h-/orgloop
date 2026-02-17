/**
 * Runtime — the long-lived host process.
 *
 * Owns shared infrastructure (bus, scheduler, logger, webhook server)
 * and manages modules through a registry. Modules are loaded/unloaded
 * independently without affecting each other.
 */

import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
	LogEntry,
	LogPhase,
	ModuleStatus,
	OrgLoopEvent,
	RouteDeliveryConfig,
	RuntimeStatus,
} from '@orgloop/sdk';
import { generateTraceId } from '@orgloop/sdk';
import type { EventBus } from './bus.js';
import { InMemoryBus } from './bus.js';
import { ConnectorError, DeliveryError, ModuleNotFoundError } from './errors.js';
import type { RuntimeControl } from './http.js';
import { DEFAULT_HTTP_PORT, WebhookServer } from './http.js';
import { LoggerManager } from './logger.js';
import type { ModuleConfig } from './module-instance.js';
import { ModuleInstance } from './module-instance.js';
import { stripFrontMatter } from './prompt.js';
import { ModuleRegistry } from './registry.js';
import { matchRoutes } from './router.js';
import { Scheduler } from './scheduler.js';
import type { CheckpointStore } from './store.js';
import { InMemoryCheckpointStore } from './store.js';
import type { TransformPipelineOptions } from './transform.js';
import { executeTransformPipeline } from './transform.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SourceCircuitBreakerOptions {
	/** Consecutive failures before opening circuit (default: 5) */
	failureThreshold?: number;
	/** Backoff period in ms before retry when circuit is open (default: 60000) */
	retryAfterMs?: number;
}

export interface RuntimeOptions {
	/** Custom event bus (default: InMemoryBus) */
	bus?: EventBus;
	/** Shared logger manager (default: new LoggerManager) */
	loggerManager?: LoggerManager;
	/** HTTP port for webhook server and control API (default: 4800) */
	httpPort?: number;
	/** Circuit breaker options for source polling */
	circuitBreaker?: SourceCircuitBreakerOptions;
	/** Data directory for checkpoints and WAL */
	dataDir?: string;
	/** Enable crash handlers for uncaught exceptions/rejections (default: true) */
	crashHandlers?: boolean;
	/** Enable health heartbeat file (default: true when running as daemon) */
	heartbeat?: boolean;
	/** Heartbeat interval in ms (default: 30000) */
	heartbeatIntervalMs?: number;
}

export interface LoadModuleOptions {
	/** Pre-instantiated source connectors (keyed by source ID) */
	sources?: Map<string, import('@orgloop/sdk').SourceConnector>;
	/** Pre-instantiated actor connectors (keyed by actor ID) */
	actors?: Map<string, import('@orgloop/sdk').ActorConnector>;
	/** Pre-instantiated package transforms (keyed by transform name) */
	transforms?: Map<string, import('@orgloop/sdk').Transform>;
	/** Pre-instantiated loggers (keyed by logger name) */
	loggers?: Map<string, import('@orgloop/sdk').Logger>;
	/** Custom checkpoint store for this module */
	checkpointStore?: CheckpointStore;
}

// ─── Runtime Class ───────────────────────────────────────────────────────────

class Runtime extends EventEmitter implements RuntimeControl {
	// Shared infrastructure
	private readonly bus: EventBus;
	private readonly scheduler = new Scheduler();
	private readonly loggerManager: LoggerManager;
	private readonly registry = new ModuleRegistry();
	private readonly webhookServer: WebhookServer;

	// Running state
	private running = false;
	private httpStarted = false;
	private startedAt = 0;
	private readonly httpPort: number;
	private readonly dataDir?: string;

	// Circuit breaker
	private readonly circuitBreakerOpts: Required<SourceCircuitBreakerOptions>;
	private readonly circuitRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

	// Stored configs for reload
	private readonly moduleConfigs = new Map<string, ModuleConfig>();
	private readonly moduleLoadOptions = new Map<string, LoadModuleOptions>();

	// Crash handlers
	private readonly enableCrashHandlers: boolean;
	private crashHandlersBound = false;
	private boundUncaughtHandler: ((err: Error) => void) | null = null;
	private boundRejectionHandler: ((reason: unknown) => void) | null = null;

	// Health heartbeat
	private readonly enableHeartbeat: boolean;
	private readonly heartbeatIntervalMs: number;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private readonly heartbeatDir = join(homedir(), '.orgloop');
	private readonly heartbeatFile = join(homedir(), '.orgloop', 'heartbeat');

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
		this.webhookServer = new WebhookServer((event) => this.inject(event));
		this.enableCrashHandlers = options?.crashHandlers ?? true;
		this.enableHeartbeat = options?.heartbeat ?? !!process.env.ORGLOOP_DAEMON;
		this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 30_000;
	}

	// ─── Lifecycle ───────────────────────────────────────────────────────────

	async start(): Promise<void> {
		if (this.running) return;

		// Install crash handlers
		if (this.enableCrashHandlers) {
			this.installCrashHandlers();
		}

		// Start scheduler
		this.scheduler.start((sourceId, moduleName) => this.pollSource(sourceId, moduleName));

		this.running = true;
		this.startedAt = Date.now();

		// Start health heartbeat
		if (this.enableHeartbeat) {
			this.startHeartbeat();
		}

		await this.emitLog('runtime.start', { result: 'started' });
	}

	/** Start the HTTP server for webhooks and control API. */
	async startHttpServer(): Promise<void> {
		if (this.httpStarted) return;
		this.webhookServer.runtime = this;
		await this.webhookServer.start(this.httpPort);
		this.httpStarted = true;
	}

	/** Whether the HTTP server is currently running. */
	isHttpStarted(): boolean {
		return this.httpStarted;
	}

	async stop(): Promise<void> {
		if (!this.running) return;

		await this.emitLog('runtime.stop', { result: 'stopping' });

		// Deactivate and shutdown all modules
		for (const mod of this.registry.list()) {
			try {
				mod.deactivate();
				this.scheduler.removeSources(mod.name);
				await mod.shutdown();
			} catch {
				// Non-blocking
			}
		}

		// Stop webhook server
		if (this.httpStarted) {
			await this.webhookServer.stop();
			this.httpStarted = false;
		}

		// Stop scheduler
		this.scheduler.stop();

		// Clear circuit breaker timers
		for (const timer of this.circuitRetryTimers.values()) {
			clearTimeout(timer);
		}
		this.circuitRetryTimers.clear();

		// Stop heartbeat
		this.stopHeartbeat();

		// Remove crash handlers
		this.removeCrashHandlers();

		// Flush and shutdown loggers
		await this.loggerManager.flush();
		await this.loggerManager.shutdown();

		this.running = false;
	}

	// ─── Module Management ───────────────────────────────────────────────────

	async loadModule(config: ModuleConfig, options?: LoadModuleOptions): Promise<ModuleStatus> {
		const checkpointStore = options?.checkpointStore ?? new InMemoryCheckpointStore();

		const mod = new ModuleInstance(config, {
			sources: options?.sources ?? new Map(),
			actors: options?.actors ?? new Map(),
			transforms: options?.transforms ?? new Map(),
			loggers: options?.loggers ?? new Map(),
			checkpointStore,
		});

		// Initialize all connectors
		await mod.initialize();

		// Activate and register before adding to scheduler
		// (so the first poll finds the module in the registry)
		mod.activate();
		this.registry.register(mod);

		// Add module loggers to shared LoggerManager (tagged with module name)
		for (const [, logger] of mod.getLoggers()) {
			this.loggerManager.addLogger(logger, mod.name);
		}

		// Register poll sources with shared scheduler
		const defaultInterval = config.defaults?.poll_interval ?? '5m';
		let hasWebhooks = false;
		for (const srcCfg of config.sources) {
			const connector = mod.getSource(srcCfg.id);
			if (!connector) continue;

			if (typeof connector.webhook === 'function') {
				// Webhook-based source: register with shared server
				this.webhookServer.addHandler(srcCfg.id, connector.webhook());
				hasWebhooks = true;
			} else {
				// Poll-based source: register with shared scheduler
				const interval = srcCfg.poll?.interval ?? defaultInterval;
				this.scheduler.addSource(srcCfg.id, interval, mod.name);
			}
		}

		// Start HTTP server on demand when webhook sources are present
		if (hasWebhooks && !this.httpStarted) {
			await this.startHttpServer();
		}

		// Store config and options for reload
		this.moduleConfigs.set(config.name, config);
		if (options) {
			this.moduleLoadOptions.set(config.name, options);
		}

		await this.emitLog('module.active', {
			result: `module "${config.name}" loaded`,
			module: config.name,
		});

		return mod.status();
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

		// Deactivate
		mod.deactivate();

		// Remove sources from scheduler
		this.scheduler.removeSources(name);

		// Remove webhook handlers for module sources
		for (const srcCfg of mod.config.sources) {
			this.webhookServer.removeHandler(srcCfg.id);
		}

		// Shutdown module resources
		await mod.shutdown();

		// Remove loggers by module tag
		this.loggerManager.removeLoggersByTag(name);

		// Unregister from registry
		this.registry.unregister(name);

		// Clean stored config
		this.moduleConfigs.delete(name);
		this.moduleLoadOptions.delete(name);

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

	// ─── Event Processing ────────────────────────────────────────────────────

	async inject(event: OrgLoopEvent, moduleName?: string): Promise<void> {
		const resolved = event.trace_id ? event : { ...event, trace_id: generateTraceId() };

		if (moduleName) {
			const mod = this.registry.get(moduleName);
			if (!mod) {
				throw new ModuleNotFoundError(moduleName);
			}
			await this.processEvent(resolved, mod);
		} else {
			// Process through all active modules
			for (const mod of this.registry.list()) {
				if (mod.getState() === 'active') {
					await this.processEvent(resolved, mod);
				}
			}
		}
	}

	private async processEvent(event: OrgLoopEvent, mod: ModuleInstance): Promise<void> {
		this.emit('event', event);

		await this.emitLog('source.emit', {
			event_id: event.id,
			trace_id: event.trace_id,
			source: event.source,
			event_type: event.type,
			module: mod.name,
		});

		// Write to bus (WAL)
		await this.bus.publish(event);

		// Match routes from this module
		const matched = matchRoutes(event, mod.getRoutes());

		if (matched.length === 0) {
			await this.emitLog('route.no_match', {
				event_id: event.id,
				trace_id: event.trace_id,
				source: event.source,
				module: mod.name,
			});
			await this.bus.ack(event.id);
			return;
		}

		// Process each matched route
		for (const match of matched) {
			const { route } = match;

			await this.emitLog('route.match', {
				event_id: event.id,
				trace_id: event.trace_id,
				route: route.name,
				source: event.source,
				target: route.then.actor,
				module: mod.name,
			});

			// Run transform pipeline
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
						continue; // Skip delivery for this route
					}
					transformedEvent = result.event;
				} catch (err) {
					// halt policy throws TransformError — emit error and skip delivery
					this.emit('error', err as Error);
					continue;
				}
			}

			// Deliver to actor
			await this.deliverToActor(transformedEvent, route.name, route.then.actor, route, mod);
		}

		// Ack the event after all routes processed
		await this.bus.ack(event.id);
	}

	private async deliverToActor(
		event: OrgLoopEvent,
		routeName: string,
		actorId: string,
		route: import('@orgloop/sdk').RouteDefinition,
		mod: ModuleInstance,
	): Promise<void> {
		const actor = mod.getActor(actorId);
		if (!actor) {
			const error = new DeliveryError(actorId, routeName, `Actor "${actorId}" not found`);
			this.emit('error', error);
			return;
		}

		await this.emitLog('deliver.attempt', {
			event_id: event.id,
			trace_id: event.trace_id,
			route: routeName,
			target: actorId,
			module: mod.name,
		});

		const startTime = Date.now();

		try {
			// Build delivery config
			const deliveryConfig: RouteDeliveryConfig = {
				...(route.then.config ?? {}),
			};

			// Resolve launch prompt if configured
			if (route.with?.prompt_file) {
				try {
					const promptContent = await readFile(route.with.prompt_file, 'utf-8');
					const { content: strippedContent, metadata } = stripFrontMatter(promptContent);
					deliveryConfig.launch_prompt = strippedContent;
					deliveryConfig.launch_prompt_file = route.with.prompt_file;
					deliveryConfig.launch_prompt_meta = metadata;
				} catch {
					// Non-fatal: log but continue delivery
				}
			}

			const result = await actor.deliver(event, deliveryConfig);
			const durationMs = Date.now() - startTime;

			if (result.status === 'delivered') {
				await this.emitLog('deliver.success', {
					event_id: event.id,
					trace_id: event.trace_id,
					route: routeName,
					target: actorId,
					duration_ms: durationMs,
					module: mod.name,
				});
				this.emit('delivery', {
					event,
					route: routeName,
					actor: actorId,
					status: 'delivered',
				});
			} else {
				await this.emitLog('deliver.failure', {
					event_id: event.id,
					trace_id: event.trace_id,
					route: routeName,
					target: actorId,
					duration_ms: durationMs,
					error: result.error?.message ?? result.status,
					module: mod.name,
				});
				this.emit('delivery', {
					event,
					route: routeName,
					actor: actorId,
					status: result.status,
				});
			}
		} catch (err) {
			const durationMs = Date.now() - startTime;
			const error = new DeliveryError(actorId, routeName, 'Delivery failed', { cause: err });
			this.emit('error', error);
			await this.emitLog('deliver.failure', {
				event_id: event.id,
				trace_id: event.trace_id,
				route: routeName,
				target: actorId,
				duration_ms: durationMs,
				error: error.message,
				module: mod.name,
			});
		}
	}

	// ─── Source Polling ───────────────────────────────────────────────────────

	private async pollSource(sourceId: string, moduleName?: string): Promise<void> {
		if (!moduleName) return;

		const mod = this.registry.get(moduleName);
		if (!mod || mod.getState() !== 'active') return;

		const connector = mod.getSource(sourceId);
		if (!connector) return;

		const healthState = mod.getHealthState(sourceId);
		if (!healthState) return;

		// Circuit breaker: skip poll if circuit is open
		if (healthState.circuitOpen) {
			return;
		}

		healthState.lastPollAttempt = new Date().toISOString();

		try {
			const store = mod.getCheckpointStore();
			const checkpoint = await store.get(sourceId);
			const result = await connector.poll(checkpoint);

			// Save checkpoint
			if (result.checkpoint) {
				await store.set(sourceId, result.checkpoint);
			}

			// Record successful poll
			healthState.lastSuccessfulPoll = new Date().toISOString();
			healthState.lastError = null;
			healthState.totalEventsEmitted += result.events.length;

			// If recovering from errors, log recovery
			if (healthState.consecutiveErrors > 0) {
				await this.emitLog('source.circuit_close', {
					source: sourceId,
					result: `recovered after ${healthState.consecutiveErrors} consecutive errors`,
					module: moduleName,
				});
			}

			healthState.consecutiveErrors = 0;
			healthState.status = 'healthy';

			// Process each event through the module
			for (const event of result.events) {
				const enriched = event.trace_id ? event : { ...event, trace_id: generateTraceId() };
				await this.processEvent(enriched, mod);
			}
		} catch (err) {
			const error = new ConnectorError(sourceId, 'Poll failed', { cause: err });
			this.emit('error', error);

			healthState.consecutiveErrors++;
			healthState.lastError = err instanceof Error ? err.message : String(err);

			// Update health status
			if (healthState.consecutiveErrors >= this.circuitBreakerOpts.failureThreshold) {
				healthState.status = 'unhealthy';
				healthState.circuitOpen = true;

				await this.emitLog('source.circuit_open', {
					source: sourceId,
					error: healthState.lastError,
					result: `${healthState.consecutiveErrors} consecutive failures — polling paused, will retry in ${Math.round(this.circuitBreakerOpts.retryAfterMs / 1000)}s`,
					module: moduleName,
				});

				// Schedule a retry after backoff
				this.scheduleCircuitRetry(sourceId, moduleName);
			} else {
				healthState.status = 'degraded';
				await this.emitLog('system.error', {
					source: sourceId,
					error: error.message,
					module: moduleName,
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

			// Temporarily allow poll by opening the circuit
			healthState.circuitOpen = false;
			await this.pollSource(sourceId, moduleName);
		}, this.circuitBreakerOpts.retryAfterMs);

		this.circuitRetryTimers.set(timerKey, timer);
	}

	// ─── Crash Handlers ─────────────────────────────────────────────────────

	private installCrashHandlers(): void {
		if (this.crashHandlersBound) return;

		this.boundUncaughtHandler = (err: Error) => {
			const message = `Uncaught exception: ${err.message}`;
			console.error(`[orgloop] ${message}`);
			console.error(err.stack);
			this.emit('error', err);
			void this.emitLog('system.error', { error: message }).catch(() => {});
			// Attempt graceful shutdown with timeout
			const forceExit = setTimeout(() => process.exit(1), 5_000);
			if (forceExit.unref) forceExit.unref();
			void this.stop()
				.catch(() => {})
				.finally(() => {
					clearTimeout(forceExit);
					process.exit(1);
				});
		};

		this.boundRejectionHandler = (reason: unknown) => {
			const message = `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`;
			console.error(`[orgloop] ${message}`);
			if (reason instanceof Error && reason.stack) {
				console.error(reason.stack);
			}
			this.emit('error', reason instanceof Error ? reason : new Error(message));
			void this.emitLog('system.error', { error: message }).catch(() => {});
			// Attempt graceful shutdown with timeout
			const forceExit = setTimeout(() => process.exit(1), 5_000);
			if (forceExit.unref) forceExit.unref();
			void this.stop()
				.catch(() => {})
				.finally(() => {
					clearTimeout(forceExit);
					process.exit(1);
				});
		};

		process.on('uncaughtException', this.boundUncaughtHandler);
		process.on('unhandledRejection', this.boundRejectionHandler);
		this.crashHandlersBound = true;
	}

	private removeCrashHandlers(): void {
		if (!this.crashHandlersBound) return;
		if (this.boundUncaughtHandler) {
			process.removeListener('uncaughtException', this.boundUncaughtHandler);
			this.boundUncaughtHandler = null;
		}
		if (this.boundRejectionHandler) {
			process.removeListener('unhandledRejection', this.boundRejectionHandler);
			this.boundRejectionHandler = null;
		}
		this.crashHandlersBound = false;
	}

	// ─── Health Heartbeat ────────────────────────────────────────────────────

	private startHeartbeat(): void {
		if (this.heartbeatTimer) return;
		// Write immediately, then on interval
		void this.writeHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			void this.writeHeartbeat();
		}, this.heartbeatIntervalMs);
		if (this.heartbeatTimer.unref) {
			this.heartbeatTimer.unref();
		}
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private async writeHeartbeat(): Promise<void> {
		try {
			await mkdir(this.heartbeatDir, { recursive: true });
			const data = JSON.stringify({
				pid: process.pid,
				timestamp: new Date().toISOString(),
				uptime_ms: this.running ? Date.now() - this.startedAt : 0,
				modules: this.registry.list().length,
			});
			await writeFile(this.heartbeatFile, data, 'utf-8');
		} catch {
			// Non-fatal: heartbeat is best-effort
		}
	}

	// ─── RuntimeControl Implementation ───────────────────────────────────────

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

	// ─── Logging ─────────────────────────────────────────────────────────────

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
