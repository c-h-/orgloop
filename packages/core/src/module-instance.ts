/**
 * ModuleInstance — owns all resources (sources, actors, transforms, loggers)
 * for a single loaded module.
 *
 * Tracks lifecycle state, health, and provides accessors for the runtime
 * to poll sources, deliver events, and query status.
 */

import type {
	ActorConnector,
	ActorInstanceConfig,
	Logger,
	LoggerDefinition,
	ModuleState,
	ModuleStatus,
	RouteDefinition,
	SourceConnector,
	SourceHealthState,
	SourceHealthStatus,
	SourceInstanceConfig,
	Transform,
	TransformDefinition,
} from '@orgloop/sdk';
import type { CheckpointStore } from './store.js';

// ─── Configuration Types ─────────────────────────────────────────────────────

/** Configuration for a loaded module */
export interface ModuleConfig {
	/** Module name (singleton identity) */
	name: string;
	/** Source definitions */
	sources: SourceInstanceConfig[];
	/** Actor definitions */
	actors: ActorInstanceConfig[];
	/** Route definitions */
	routes: RouteDefinition[];
	/** Transform definitions */
	transforms: TransformDefinition[];
	/** Logger definitions */
	loggers: LoggerDefinition[];
	/** Defaults */
	defaults?: { poll_interval?: string };
	/** Filesystem path to the module */
	modulePath?: string;
}

/** Context for module-scoped operations */
export interface ModuleContext {
	name: string;
	checkpointStore: CheckpointStore;
}

// ─── ModuleInstance Class ─────────────────────────────────────────────────────

export class ModuleInstance {
	readonly name: string;
	readonly config: ModuleConfig;
	private state: ModuleState = 'loading';
	private startedAt = 0;

	// Module-owned resources
	private readonly sources: Map<string, SourceConnector>;
	private readonly actors: Map<string, ActorConnector>;
	private readonly packageTransforms: Map<string, Transform>;
	private readonly moduleLoggers: Map<string, Logger>;
	private readonly checkpointStore: CheckpointStore;
	private readonly healthStates: Map<string, SourceHealthState>;

	constructor(
		config: ModuleConfig,
		options: {
			sources: Map<string, SourceConnector>;
			actors: Map<string, ActorConnector>;
			transforms: Map<string, Transform>;
			loggers: Map<string, Logger>;
			checkpointStore: CheckpointStore;
		},
	) {
		this.name = config.name;
		this.config = config;
		this.sources = options.sources;
		this.actors = options.actors;
		this.packageTransforms = options.transforms;
		this.moduleLoggers = options.loggers;
		this.checkpointStore = options.checkpointStore;
		this.healthStates = new Map();

		// Initialize health states for all sources
		for (const src of config.sources) {
			this.healthStates.set(src.id, {
				sourceId: src.id,
				status: 'healthy' as SourceHealthStatus,
				lastSuccessfulPoll: null,
				lastPollAttempt: null,
				consecutiveErrors: 0,
				lastError: null,
				totalEventsEmitted: 0,
				circuitOpen: false,
			});
		}
	}

	/** Initialize all connectors. Called during module load. */
	async initialize(): Promise<void> {
		// Init sources
		for (const [id, source] of this.sources) {
			const srcConfig = this.config.sources.find((s) => s.id === id);
			if (srcConfig) {
				await source.init({
					id: srcConfig.id,
					connector: srcConfig.connector,
					config: srcConfig.config,
					poll: srcConfig.poll,
				});
			}
		}
		// Init actors
		for (const [id, actor] of this.actors) {
			const actConfig = this.config.actors.find((a) => a.id === id);
			if (actConfig) {
				await actor.init({
					id: actConfig.id,
					connector: actConfig.connector,
					config: actConfig.config,
				});
			}
		}
		// Init transforms
		for (const [id, transform] of this.packageTransforms) {
			const txConfig = this.config.transforms.find((t) => t.name === id);
			await transform.init(txConfig?.config ?? {});
		}
		// Init loggers
		for (const [id, logger] of this.moduleLoggers) {
			const lgConfig = this.config.loggers.find((l) => l.name === id);
			if (lgConfig) {
				await logger.init(lgConfig.config);
			}
		}
	}

	/** Mark module as active. */
	activate(): void {
		this.state = 'active';
		this.startedAt = Date.now();
	}

	/** Begin unloading — mark state, stop accepting new events. */
	deactivate(): void {
		this.state = 'unloading';
	}

	/** Shutdown all owned resources. */
	async shutdown(): Promise<void> {
		// Shutdown sources
		for (const source of this.sources.values()) {
			try {
				await source.shutdown();
			} catch {
				/* non-blocking */
			}
		}
		// Shutdown actors
		for (const actor of this.actors.values()) {
			try {
				await actor.shutdown();
			} catch {
				/* non-blocking */
			}
		}
		// Shutdown transforms
		for (const transform of this.packageTransforms.values()) {
			if ('shutdown' in transform && typeof transform.shutdown === 'function') {
				try {
					await transform.shutdown();
				} catch {
					/* non-blocking */
				}
			}
		}
		// Shutdown loggers
		for (const logger of this.moduleLoggers.values()) {
			try {
				await logger.shutdown();
			} catch {
				/* non-blocking */
			}
		}
		this.state = 'removed';
	}

	// ─── Accessors ─────────────────────────────────────────────────────────────

	getState(): ModuleState {
		return this.state;
	}

	getRoutes(): RouteDefinition[] {
		return this.config.routes;
	}

	getSource(id: string): SourceConnector | undefined {
		return this.sources.get(id);
	}

	getActor(id: string): ActorConnector | undefined {
		return this.actors.get(id);
	}

	getTransform(name: string): Transform | undefined {
		return this.packageTransforms.get(name);
	}

	getTransformsMap(): Map<string, Transform> {
		return this.packageTransforms;
	}

	getLoggers(): Map<string, Logger> {
		return this.moduleLoggers;
	}

	getHealth(): SourceHealthState[] {
		return [...this.healthStates.values()];
	}

	getHealthState(sourceId: string): SourceHealthState | undefined {
		return this.healthStates.get(sourceId);
	}

	updateHealth(sourceId: string, update: Partial<SourceHealthState>): void {
		const existing = this.healthStates.get(sourceId);
		if (existing) {
			Object.assign(existing, update);
		}
	}

	getContext(): ModuleContext {
		return { name: this.name, checkpointStore: this.checkpointStore };
	}

	getCheckpointStore(): CheckpointStore {
		return this.checkpointStore;
	}

	status(): ModuleStatus {
		return {
			name: this.name,
			state: this.state,
			sources: this.sources.size,
			routes: this.config.routes.length,
			actors: this.actors.size,
			uptime_ms: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
			health: this.getHealth(),
		};
	}
}
