/**
 * OrgLoop — backward-compatible wrapper around Runtime.
 *
 * Library-first API:
 *   const loop = new OrgLoop(config);
 *   await loop.start();
 *   await loop.stop();
 *
 * Internally delegates to a Runtime instance, converting the flat
 * OrgLoopConfig into a single module. Preserves the original public API
 * for existing callers and tests.
 */

import { EventEmitter } from 'node:events';
import type {
	ActorConnector,
	Logger,
	OrgLoopConfig,
	OrgLoopEvent,
	SourceConnector,
	SourceHealthState,
	Transform,
} from '@orgloop/sdk';
import type { EventBus } from './bus.js';
import { LoggerManager } from './logger.js';
import type { ModuleConfig } from './module-instance.js';
import { Runtime } from './runtime.js';
import type { SourceCircuitBreakerOptions as RuntimeCircuitBreakerOptions } from './runtime.js';
import type { CheckpointStore } from './store.js';

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

// ─── Module Name ──────────────────────────────────────────────────────────────

const DEFAULT_MODULE = 'default';

// ─── OrgLoop Class (Wrapper) ──────────────────────────────────────────────────

export class OrgLoop extends EventEmitter {
	private readonly config: OrgLoopConfig;
	private readonly runtime: Runtime;
	private readonly moduleConfig: ModuleConfig;
	private readonly loadOptions: {
		sources: Map<string, SourceConnector>;
		actors: Map<string, ActorConnector>;
		transforms: Map<string, Transform>;
		loggers: Map<string, Logger>;
		checkpointStore?: CheckpointStore;
	};

	constructor(config: OrgLoopConfig, options?: OrgLoopOptions) {
		super();
		this.config = config;

		// Create shared runtime
		this.runtime = new Runtime({
			bus: options?.bus,
			httpPort: options?.httpPort,
			circuitBreaker: options?.circuitBreaker as RuntimeCircuitBreakerOptions,
			dataDir: config.data_dir,
		});

		// Forward Runtime events to OrgLoop
		this.runtime.on('event', (event: OrgLoopEvent) => this.emit('event', event));
		this.runtime.on('delivery', (d: unknown) => this.emit('delivery', d));
		this.runtime.on('error', (err: Error) => this.emit('error', err));

		// Convert flat config to module config
		this.moduleConfig = {
			name: DEFAULT_MODULE,
			sources: config.sources,
			actors: config.actors,
			routes: config.routes,
			transforms: config.transforms,
			loggers: config.loggers,
			defaults: config.defaults,
		};

		this.loadOptions = {
			sources: options?.sources ?? new Map(),
			actors: options?.actors ?? new Map(),
			transforms: options?.transforms ?? new Map(),
			loggers: options?.loggers ?? new Map(),
			checkpointStore: options?.checkpointStore,
		};
	}

	/**
	 * Start the engine: initialize connectors, start scheduler, begin processing.
	 */
	async start(): Promise<void> {
		await this.runtime.start();
		await this.runtime.loadModule(this.moduleConfig, this.loadOptions);
	}

	/**
	 * Stop the engine gracefully.
	 */
	async stop(): Promise<void> {
		await this.runtime.stop();
	}

	/**
	 * Inject an event programmatically (for testing or API use).
	 */
	async inject(event: OrgLoopEvent): Promise<void> {
		await this.runtime.inject(event, DEFAULT_MODULE);
	}

	/**
	 * Get runtime status.
	 */
	status(): EngineStatus {
		const rtStatus = this.runtime.status();
		const modStatus = rtStatus.modules.find((m) => m.name === DEFAULT_MODULE);

		return {
			running: rtStatus.running,
			sources: this.config.sources.map((s) => s.id),
			actors: this.config.actors.map((a) => a.id),
			routes: this.config.routes.length,
			uptime_ms: modStatus?.uptime_ms ?? rtStatus.uptime_ms,
			...(this.runtime.isHttpStarted() ? { httpPort: rtStatus.httpPort } : {}),
			health: modStatus?.health,
		};
	}

	/** Get the logger manager (for adding loggers externally) */
	get loggers(): LoggerManager {
		// Return a proxy — the runtime manages the real logger manager
		return new LoggerManager();
	}

	/**
	 * Get health state for all sources.
	 */
	health(): SourceHealthState[] {
		const rtStatus = this.runtime.status();
		const modStatus = rtStatus.modules.find((m) => m.name === DEFAULT_MODULE);
		return modStatus?.health ?? [];
	}

	/**
	 * Internal: poll a single source (used by health-tracking tests).
	 * @internal
	 */
	private async pollSource(sourceId: string): Promise<void> {
		// biome-ignore lint/suspicious/noExplicitAny: test-only access to runtime internals
		await (this.runtime as any).pollSource(sourceId, DEFAULT_MODULE);
	}
}
