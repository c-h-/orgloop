/**
 * @orgloop/sdk — OrgLoop Plugin Development Kit
 *
 * This package provides the interfaces, helpers, and test harnesses
 * for building OrgLoop plugins (connectors, transforms, loggers).
 */

// Connector interfaces
export type {
	ActorConnector,
	ConnectorIntegration,
	ConnectorRegistration,
	ConnectorSetup,
	CredentialValidator,
	DeliveryResult,
	EnvVarDefinition,
	PollResult,
	ServiceDetector,
	SourceConnector,
	WebhookHandler,
} from './connector.js';
export type { BuildEventOptions, ValidationError } from './event.js';
// Event helpers
export {
	buildEvent,
	generateEventId,
	generateTraceId,
	isOrgLoopEvent,
	validateEvent,
} from './event.js';
// Logger interface
export type {
	Logger,
	LoggerRegistration,
} from './logger.js';
// Test harness
export {
	createTestContext,
	createTestEvent,
	MockActor,
	MockLogger,
	MockSource,
	MockTransform,
} from './testing.js';
// Transform interface
export type {
	Transform,
	TransformContext,
	TransformRegistration,
} from './transform.js';
// Core types
export type {
	ActorConfig,
	ActorInstanceConfig,
	AuthorType,
	BootModuleEntry,
	CircuitBreakerConfig,
	DeliveryConfig,
	DurationString,
	EventFilter,
	EventHandler,
	EventProvenance,
	LogEntry,
	LoggerDefinition,
	LogPhase,
	ModuleState,
	ModuleStatus,
	OrgLoopConfig,
	OrgLoopEvent,
	OrgLoopEventType,
	PollConfig,
	ProjectConfig,
	RetryConfig,
	RouteDefinition,
	RouteDeliveryConfig,
	RouteThen,
	RouteTransformRef,
	RouteWhen,
	RouteWith,
	RuntimeConfig,
	RuntimeStatus,
	SourceConfig,
	SourceHealthState,
	SourceHealthStatus,
	SourceInstanceConfig,
	Subscription,
	TransformDefinition,
	TransformErrorPolicy,
} from './types.js';
export { parseDuration } from './types.js';
