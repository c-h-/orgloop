/**
 * OrgLoop — the main runtime engine.
 *
 * Library-first API:
 *   const loop = new OrgLoop(config);
 *   await loop.start();
 *   await loop.stop();
 */

import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import type {
	ActorConnector,
	LogEntry,
	LogPhase,
	Logger,
	OrgLoopConfig,
	OrgLoopEvent,
	RouteDeliveryConfig,
	SourceConnector,
	SourceHealthState,
	WebhookHandler,
} from '@orgloop/sdk';
import { generateTraceId } from '@orgloop/sdk';
import type { Transform } from '@orgloop/sdk';
import type { EventBus } from './bus.js';
import { InMemoryBus } from './bus.js';
import { ConnectorError, DeliveryError } from './errors.js';
import { DEFAULT_HTTP_PORT, WebhookServer } from './http.js';
import { LoggerManager } from './logger.js';
import { matchRoutes } from './router.js';
import { Scheduler } from './scheduler.js';
import type { CheckpointStore } from './store.js';
import { InMemoryCheckpointStore } from './store.js';
import { executeTransformPipeline } from './transform.js';
import type { TransformPipelineOptions } from './transform.js';

// ─── Engine Options ───────────────────────────────────────────────────────────

export interface SourceCircuitBreakerOptions {
	/** Consecutive failures before opening circuit (default: 5) */
	failureThreshold?: number;
	/** Backoff period in ms before retry when circuit is open (default: 60000) */
	retryAfterMs?: number;
}

export interface OrgLoopOptions {
	/** Pre-instantiated source connectors (keyed by source ID) */
	sources?: Map<string, SourceConnector>;
	/** Pre-instantiated actor connectors (keyed by actor ID) */
	actors?: Map<string, ActorConnector>;
	/** Pre-instantiated package transforms (keyed by transform name) */
	transforms?: Map<string, Transform>;
	/** Pre-instantiated loggers (keyed by logger name) */
	loggers?: Map<string, Logger>;
	/** Custom event bus (default: InMemoryBus) */
	bus?: EventBus;
	/** Custom checkpoint store */
	checkpointStore?: CheckpointStore;
	/** HTTP port for webhook server (default: 4800, or ORGLOOP_PORT env var) */
	httpPort?: number;
	/** Circuit breaker options for source polling */
	circuitBreaker?: SourceCircuitBreakerOptions;
}

export interface EngineStatus {
	running: boolean;
	sources: string[];
	actors: string[];
	routes: number;
	uptime_ms: number;
	httpPort?: number;
	health?: SourceHealthState[];
}

// ─── Engine Events ────────────────────────────────────────────────────────────

export interface OrgLoopEvents {
	event: [OrgLoopEvent];
	delivery: [{ event: OrgLoopEvent; route: string; actor: string; status: string }];
	error: [Error];
}

// ─── OrgLoop Class ────────────────────────────────────────────────────────────

export class OrgLoop extends EventEmitter {
	private readonly config: OrgLoopConfig;
	private readonly sources: Map<string, SourceConnector>;
	private readonly actors: Map<string, ActorConnector>;
	private readonly packageTransforms: Map<string, Transform>;
	private readonly resolvedLoggers: Map<string, Logger>;
	private readonly bus: EventBus;
	private readonly checkpointStore: CheckpointStore;
	private readonly loggerManager = new LoggerManager();
	private readonly scheduler = new Scheduler();
	private readonly httpPort: number;
	private webhookServer: WebhookServer | null = null;
	private readonly webhookSources = new Set<string>();
	private running = false;
	private startedAt = 0;

	// Health tracking
	private readonly healthStates = new Map<string, SourceHealthState>();
	private readonly circuitBreakerOpts: Required<SourceCircuitBreakerOptions>;
	private readonly circuitRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(config: OrgLoopConfig, options?: OrgLoopOptions) {
		super();
		this.config = config;
		this.sources = options?.sources ?? new Map();
		this.actors = options?.actors ?? new Map();
		this.packageTransforms = options?.transforms ?? new Map();
		this.resolvedLoggers = options?.loggers ?? new Map();
		this.bus = options?.bus ?? new InMemoryBus();
		this.checkpointStore = options?.checkpointStore ?? new InMemoryCheckpointStore();
		this.httpPort =
			options?.httpPort ??
			(process.env.ORGLOOP_PORT
				? Number.parseInt(process.env.ORGLOOP_PORT, 10)
				: DEFAULT_HTTP_PORT);
		this.circuitBreakerOpts = {
			failureThreshold: options?.circuitBreaker?.failureThreshold ?? 5,
			retryAfterMs: options?.circuitBreaker?.retryAfterMs ?? 60_000,
		};
	}

	/**
	 * Start the engine: initialize connectors, start scheduler, begin processing.
	 */
	async start(): Promise<void> {
		if (this.running) return;

		await this.emitLog('system.start', { result: 'starting' });

		// Initialize sources
		for (const sourceCfg of this.config.sources) {
			const connector = this.sources.get(sourceCfg.id);
			if (connector) {
				try {
					await connector.init({
						id: sourceCfg.id,
						connector: sourceCfg.connector,
						config: sourceCfg.config,
						poll: sourceCfg.poll,
					});
				} catch (err) {
					const error = new ConnectorError(sourceCfg.id, 'Failed to initialize source', {
						cause: err,
					});
					this.emit('error', error);
				}
			}
		}

		// Initialize actors
		for (const actorCfg of this.config.actors) {
			const connector = this.actors.get(actorCfg.id);
			if (connector) {
				try {
					await connector.init({
						id: actorCfg.id,
						connector: actorCfg.connector,
						config: actorCfg.config,
					});
				} catch (err) {
					const error = new ConnectorError(actorCfg.id, 'Failed to initialize actor', {
						cause: err,
					});
					this.emit('error', error);
				}
			}
		}

		// Initialize package transforms
		for (const tDef of this.config.transforms) {
			if (tDef.type === 'package') {
				const transform = this.packageTransforms.get(tDef.name);
				if (transform) {
					await transform.init(tDef.config ?? {});
				}
			}
		}

		// Initialize and register loggers
		for (const loggerDef of this.config.loggers) {
			const logger = this.resolvedLoggers.get(loggerDef.name);
			if (logger) {
				try {
					await logger.init(loggerDef.config ?? {});
					this.loggerManager.addLogger(logger);
				} catch (err) {
					this.emit('error', new Error(`Failed to initialize logger "${loggerDef.name}": ${err}`));
				}
			}
		}

		// Detect webhook sources and register poll sources with scheduler
		const defaultInterval = this.config.defaults?.poll_interval ?? '5m';
		const webhookHandlers = new Map<string, WebhookHandler>();

		for (const sourceCfg of this.config.sources) {
			const connector = this.sources.get(sourceCfg.id);
			if (!connector) continue;

			if (typeof connector.webhook === 'function') {
				// Webhook-based source: mount handler, skip polling
				webhookHandlers.set(sourceCfg.id, connector.webhook());
				this.webhookSources.add(sourceCfg.id);
			} else {
				// Poll-based source: register with scheduler
				const interval = sourceCfg.poll?.interval ?? defaultInterval;
				this.scheduler.addSource(sourceCfg.id, interval);
			}
		}

		// Start webhook server if any webhook sources registered
		if (webhookHandlers.size > 0) {
			this.webhookServer = new WebhookServer(webhookHandlers, (event) => this.inject(event));
			await this.webhookServer.start(this.httpPort);
		}

		// Initialize health state for all sources
		for (const sourceCfg of this.config.sources) {
			this.healthStates.set(sourceCfg.id, {
				sourceId: sourceCfg.id,
				status: 'healthy',
				lastSuccessfulPoll: null,
				lastPollAttempt: null,
				consecutiveErrors: 0,
				lastError: null,
				totalEventsEmitted: 0,
				circuitOpen: false,
			});
		}

		// Start scheduler
		this.scheduler.start((sourceId) => this.pollSource(sourceId));

		this.running = true;
		this.startedAt = Date.now();

		await this.emitLog('system.start', { result: 'started' });
	}

	/**
	 * Stop the engine gracefully.
	 */
	async stop(): Promise<void> {
		if (!this.running) return;

		await this.emitLog('system.stop', { result: 'stopping' });

		// Stop webhook server
		if (this.webhookServer) {
			await this.webhookServer.stop();
			this.webhookServer = null;
		}

		// Stop scheduler
		this.scheduler.stop();

		// Clear circuit breaker retry timers
		for (const timer of this.circuitRetryTimers.values()) {
			clearTimeout(timer);
		}
		this.circuitRetryTimers.clear();

		// Shutdown sources
		for (const [id, connector] of this.sources) {
			try {
				await connector.shutdown();
			} catch (err) {
				this.emit('error', new ConnectorError(id, 'Error during source shutdown', { cause: err }));
			}
		}

		// Shutdown actors
		for (const [id, connector] of this.actors) {
			try {
				await connector.shutdown();
			} catch (err) {
				this.emit('error', new ConnectorError(id, 'Error during actor shutdown', { cause: err }));
			}
		}

		// Shutdown transforms
		for (const [, transform] of this.packageTransforms) {
			try {
				await transform.shutdown();
			} catch {
				// Swallow
			}
		}

		// Flush and shutdown loggers
		await this.loggerManager.flush();
		await this.loggerManager.shutdown();

		this.running = false;

		await this.emitLog('system.stop', { result: 'stopped' });
	}

	/**
	 * Inject an event programmatically (for testing or API use).
	 */
	async inject(event: OrgLoopEvent): Promise<void> {
		const resolved = event.trace_id ? event : { ...event, trace_id: generateTraceId() };
		await this.processEvent(resolved);
	}

	/**
	 * Get runtime status.
	 */
	status(): EngineStatus {
		return {
			running: this.running,
			sources: [...this.sources.keys()],
			actors: [...this.actors.keys()],
			routes: this.config.routes.length,
			uptime_ms: this.running ? Date.now() - this.startedAt : 0,
			...(this.webhookServer ? { httpPort: this.httpPort } : {}),
			health: this.health(),
		};
	}

	/** Get the logger manager (for adding loggers externally) */
	get loggers(): LoggerManager {
		return this.loggerManager;
	}

	/**
	 * Get health state for all sources.
	 */
	health(): SourceHealthState[] {
		return [...this.healthStates.values()];
	}

	// ─── Internal: Poll a source ──────────────────────────────────────────────

	private async pollSource(sourceId: string): Promise<void> {
		const connector = this.sources.get(sourceId);
		if (!connector) return;

		const healthState = this.healthStates.get(sourceId);
		if (!healthState) return;

		// Circuit breaker: skip poll if circuit is open
		if (healthState.circuitOpen) {
			return;
		}

		healthState.lastPollAttempt = new Date().toISOString();

		try {
			const checkpoint = await this.checkpointStore.get(sourceId);
			const result = await connector.poll(checkpoint);

			// Save checkpoint
			if (result.checkpoint) {
				await this.checkpointStore.set(sourceId, result.checkpoint);
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
				});
			}

			healthState.consecutiveErrors = 0;
			healthState.status = 'healthy';

			// Process each event
			for (const event of result.events) {
				const enriched = event.trace_id ? event : { ...event, trace_id: generateTraceId() };
				await this.processEvent(enriched);
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
				});

				// Schedule a retry after backoff
				this.scheduleCircuitRetry(sourceId);
			} else {
				healthState.status = 'degraded';
				await this.emitLog('system.error', {
					source: sourceId,
					error: error.message,
				});
			}
		}
	}

	/**
	 * Schedule a single retry poll after the backoff period.
	 * If it succeeds, resume normal polling. If not, stay in circuit-open state.
	 */
	private scheduleCircuitRetry(sourceId: string): void {
		// Clear any existing retry timer for this source
		const existing = this.circuitRetryTimers.get(sourceId);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(async () => {
			this.circuitRetryTimers.delete(sourceId);
			if (!this.running) return;

			const healthState = this.healthStates.get(sourceId);
			if (!healthState || !healthState.circuitOpen) return;

			await this.emitLog('source.circuit_retry', {
				source: sourceId,
				result: 'attempting recovery poll',
			});

			// Temporarily allow poll by opening the circuit
			healthState.circuitOpen = false;
			await this.pollSource(sourceId);

			// If poll failed, circuit will be re-opened by pollSource
			// If poll succeeded, consecutiveErrors is 0 and circuitOpen stays false
		}, this.circuitBreakerOpts.retryAfterMs);

		this.circuitRetryTimers.set(sourceId, timer);
	}

	// ─── Internal: Process a single event ─────────────────────────────────────

	private async processEvent(event: OrgLoopEvent): Promise<void> {
		this.emit('event', event);

		await this.emitLog('source.emit', {
			event_id: event.id,
			trace_id: event.trace_id,
			source: event.source,
			event_type: event.type,
		});

		// Write to bus (WAL)
		await this.bus.publish(event);

		// Match routes
		const matched = matchRoutes(event, this.config.routes);

		if (matched.length === 0) {
			await this.emitLog('route.no_match', {
				event_id: event.id,
				trace_id: event.trace_id,
				source: event.source,
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
			});

			// Run transform pipeline
			let transformedEvent = event;
			if (route.transforms && route.transforms.length > 0) {
				const pipelineOptions: TransformPipelineOptions = {
					definitions: this.config.transforms,
					packageTransforms: this.packageTransforms,
					onLog: (partial) => {
						void this.emitLog(partial.phase ?? 'transform.start', {
							...partial,
							event_id: partial.event_id ?? event.id,
							trace_id: partial.trace_id ?? event.trace_id,
							route: route.name,
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
			await this.deliverToActor(transformedEvent, route.name, route.then.actor, route);
		}

		// Ack the event after all routes processed
		await this.bus.ack(event.id);
	}

	// ─── Internal: Deliver to actor ───────────────────────────────────────────

	private async deliverToActor(
		event: OrgLoopEvent,
		routeName: string,
		actorId: string,
		route: import('@orgloop/sdk').RouteDefinition,
	): Promise<void> {
		const actor = this.actors.get(actorId);
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
					deliveryConfig.launch_prompt = promptContent;
					deliveryConfig.launch_prompt_file = route.with.prompt_file;
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
				});
				this.emit('delivery', { event, route: routeName, actor: actorId, status: 'delivered' });
			} else {
				await this.emitLog('deliver.failure', {
					event_id: event.id,
					trace_id: event.trace_id,
					route: routeName,
					target: actorId,
					duration_ms: durationMs,
					error: result.error?.message ?? result.status,
				});
				this.emit('delivery', { event, route: routeName, actor: actorId, status: result.status });
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
			});
		}
	}

	// ─── Internal: Emit structured log ────────────────────────────────────────

	private async emitLog(phase: LogPhase, fields: Partial<LogEntry>): Promise<void> {
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
			workspace: this.config.project.name,
		};

		await this.loggerManager.log(entry);
	}
}
