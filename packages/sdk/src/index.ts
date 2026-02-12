/**
 * @orgloop/sdk — OrgLoop Plugin Development Kit
 *
 * This package provides the interfaces, helpers, and test harnesses
 * for building OrgLoop plugins (connectors, transforms, loggers).
 */

// Core types
export type {
	OrgLoopEvent,
	OrgLoopEventType,
	AuthorType,
	EventProvenance,
	SourceConfig,
	ActorConfig,
	PollConfig,
	RouteDefinition,
	RouteWhen,
	RouteTransformRef,
	RouteThen,
	RouteWith,
	RouteDeliveryConfig,
	TransformDefinition,
	TransformErrorPolicy,
	LoggerDefinition,
	DeliveryConfig,
	RetryConfig,
	CircuitBreakerConfig,
	LogPhase,
	LogEntry,
	ProjectConfig,
	OrgLoopConfig,
	SourceInstanceConfig,
	ActorInstanceConfig,
	EventFilter,
	EventHandler,
	Subscription,
	DurationString,
	SourceHealthStatus,
	SourceHealthState,
	ModuleState,
	ModuleStatus,
	RuntimeStatus,
	BootModuleEntry,
	RuntimeConfig,
} from './types.js';

export { parseDuration } from './types.js';

// Connector interfaces
export type {
	SourceConnector,
	ActorConnector,
	PollResult,
	DeliveryResult,
	WebhookHandler,
	ConnectorRegistration,
	ConnectorSetup,
	ConnectorIntegration,
	EnvVarDefinition,
	CredentialValidator,
	ServiceDetector,
} from './connector.js';

// Transform interface
export type {
	Transform,
	TransformContext,
	TransformRegistration,
} from './transform.js';

// Logger interface
export type {
	Logger,
	LoggerRegistration,
} from './logger.js';

// Event helpers
export {
	generateEventId,
	generateTraceId,
	buildEvent,
	validateEvent,
	isOrgLoopEvent,
} from './event.js';
export type { BuildEventOptions, ValidationError } from './event.js';

// Module types
export type {
	ModuleManifest,
	ModuleMetadata,
	ModuleRequirements,
	ModuleConnectorRequirement,
	ModuleServiceRequirement,
	ModuleCredentialRequirement,
	ModuleHookRequirement,
	ModuleParameter,
	ModuleProvides,
	InstalledModule,
	ModuleExpansionContext,
	ModuleConnectors,
	ModuleSourceDefinition,
	ModuleActorDefinition,
} from './module.js';

export { expandTemplate, expandTemplateDeep, moduleManifestSchema } from './module.js';

// Test harness
export {
	MockSource,
	MockActor,
	MockTransform,
	MockLogger,
	createTestEvent,
	createTestContext,
} from './testing.js';
