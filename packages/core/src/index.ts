/**
 * @orgloop/core — OrgLoop Runtime Engine
 *
 * Public API exports for library mode.
 */

export type { AuditFlag, AuditOutput, AuditRecord, AuditTrailOptions } from './audit.js';
// Audit trail
export { AuditTrail, contentHash, generateAuditId } from './audit.js';
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
export type { EventHistoryOptions, EventHistoryQuery, EventRecord } from './event-history.js';
// Event history
export { EventHistory } from './event-history.js';
export type { ApiHandler, RuntimeControl } from './http.js';
// HTTP webhook server
export { DEFAULT_HTTP_PORT, WebhookServer } from './http.js';
// Logger manager
export { LoggerManager } from './logger.js';
export type { ChainNode, LoopCheckResult, LoopDetectorOptions } from './loop-detector.js';
// Loop detector
export { LoopDetector } from './loop-detector.js';
export type { MetricsServerOptions } from './metrics.js';
// Prometheus metrics
export { MetricsServer } from './metrics.js';
export type { ModuleConfig, ModuleContext } from './module-instance.js';
// Module system
export { ModuleInstance } from './module-instance.js';
export type { OutputValidationResult, OutputValidatorOptions } from './output-validator.js';
// Output validator
export { OutputValidator } from './output-validator.js';
export type { StripFrontMatterResult } from './prompt.js';
// Prompt utilities
export { stripFrontMatter } from './prompt.js';
export { ModuleRegistry } from './registry.js';
// REST API
export { registerRestApi } from './rest-api.js';
export type { MatchedRoute } from './router.js';
// Router
export { matchRoutes } from './router.js';
export type { LoadModuleOptions, RouteStats, RuntimeOptions } from './runtime.js';
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
export type { SupervisorOptions, SupervisorStatus } from './supervisor.js';
// Supervisor
export { Supervisor } from './supervisor.js';
export type { TransformPipelineOptions, TransformPipelineResult } from './transform.js';
// Transform pipeline
export { executeTransformPipeline } from './transform.js';
