/**
 * @orgloop/core — OrgLoop Runtime Engine
 *
 * Public API exports for library mode.
 */

// Main engine
export { OrgLoop } from './engine.js';
export type { OrgLoopOptions, EngineStatus, SourceCircuitBreakerOptions } from './engine.js';

// Config loading
export { loadConfig, buildConfig } from './schema.js';
export type { LoadConfigOptions } from './schema.js';

// Errors
export {
	OrgLoopError,
	ConfigError,
	ConnectorError,
	TransformError,
	DeliveryError,
	SchemaError,
	ModuleConflictError,
	ModuleNotFoundError,
	RuntimeError,
} from './errors.js';

// Event bus
export { InMemoryBus, FileWalBus } from './bus.js';
export type { EventBus, BusHandler } from './bus.js';

// Stores
export {
	FileCheckpointStore,
	FileEventStore,
	InMemoryCheckpointStore,
	InMemoryEventStore,
} from './store.js';
export type { CheckpointStore, EventStore, WalEntry } from './store.js';

// Router
export { matchRoutes } from './router.js';
export type { MatchedRoute } from './router.js';

// Transform pipeline
export { executeTransformPipeline } from './transform.js';
export type { TransformPipelineOptions, TransformPipelineResult } from './transform.js';

// Logger manager
export { LoggerManager } from './logger.js';

// Scheduler
export { Scheduler } from './scheduler.js';

// HTTP webhook server
export { WebhookServer, DEFAULT_HTTP_PORT } from './http.js';
export type { RuntimeControl } from './http.js';

// Runtime (new architecture)
export { Runtime } from './runtime.js';
export type { RuntimeOptions, LoadModuleOptions } from './runtime.js';

// Module system
export { ModuleInstance } from './module-instance.js';
export type { ModuleConfig, ModuleContext } from './module-instance.js';
export { ModuleRegistry } from './registry.js';
