/**
 * @orgloop/core — OrgLoop Runtime Engine
 *
 * Public API exports for library mode.
 */

export type { BusHandler, EventBus } from './bus.js';
// Event bus
export { FileWalBus, InMemoryBus } from './bus.js';
export type { EngineStatus, OrgLoopOptions, SourceCircuitBreakerOptions } from './engine.js';
// Main engine
export { OrgLoop } from './engine.js';

// Errors
export {
	ConfigError,
	ConnectorError,
	DeliveryError,
	ModuleConflictError,
	ModuleNotFoundError,
	OrgLoopError,
	RuntimeError,
	SchemaError,
	TransformError,
} from './errors.js';
export type { RuntimeControl } from './http.js';
// HTTP webhook server
export { DEFAULT_HTTP_PORT, WebhookServer } from './http.js';
// Logger manager
export { LoggerManager } from './logger.js';
export type { ModuleConfig, ModuleContext } from './module-instance.js';
// Module system
export { ModuleInstance } from './module-instance.js';
export type { StripFrontMatterResult } from './prompt.js';
// Prompt utilities
export { stripFrontMatter } from './prompt.js';
export { ModuleRegistry } from './registry.js';
export type { MatchedRoute } from './router.js';
// Router
export { matchRoutes } from './router.js';
export type { LoadModuleOptions, RuntimeOptions } from './runtime.js';
// Runtime (new architecture)
export { Runtime } from './runtime.js';
// Scheduler
export { Scheduler } from './scheduler.js';
export type { LoadConfigOptions } from './schema.js';
// Config loading
export { buildConfig, loadConfig } from './schema.js';
export type { CheckpointStore, EventStore, WalEntry } from './store.js';
// Stores
export {
	FileCheckpointStore,
	FileEventStore,
	InMemoryCheckpointStore,
	InMemoryEventStore,
} from './store.js';
export type { TransformPipelineOptions, TransformPipelineResult } from './transform.js';
// Transform pipeline
export { executeTransformPipeline } from './transform.js';
