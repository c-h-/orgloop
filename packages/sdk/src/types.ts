/**
 * Core type definitions for OrgLoop.
 *
 * These types are the foundation of the system — every connector, transform,
 * logger, and the core engine depend on them.
 */

// ─── Event Types ──────────────────────────────────────────────────────────────

/** OaC event types — the canonical set of event categories */
export type OrgLoopEventType = 'resource.changed' | 'actor.stopped' | 'message.received';

/** Author type classification */
export type AuthorType = 'team_member' | 'external' | 'bot' | 'system' | 'unknown';

/** Event provenance — where did this event come from? */
export interface EventProvenance {
	/** Source platform identifier (e.g., "github", "linear") */
	platform: string;
	/** Platform-specific event type (e.g., "pull_request.review_submitted") */
	platform_event?: string;
	/** Author identifier */
	author?: string;
	/** Author classification */
	author_type?: AuthorType;
	/** Additional platform-specific provenance data */
	[key: string]: unknown;
}

/** The canonical OrgLoop event — every event in the system conforms to this shape */
export interface OrgLoopEvent {
	/** Unique event identifier (format: evt_*) */
	id: string;
	/** ISO 8601 timestamp (UTC) */
	timestamp: string;
	/** Source connector ID that emitted this event */
	source: string;
	/** OaC event type */
	type: OrgLoopEventType;
	/** Event provenance — platform, author, context */
	provenance: EventProvenance;
	/** Source-specific event payload */
	payload: Record<string, unknown>;
	/** Trace ID grouping all pipeline entries for this event */
	trace_id?: string;
	/** Module that emitted this event (set by runtime) */
	module?: string;
}

// ─── Configuration Types ──────────────────────────────────────────────────────

/** Source connector configuration */
export interface SourceConfig {
	/** Source ID assigned in the project config */
	id: string;
	/** Reference to the connector package */
	connector: string;
	/** Connector-specific configuration */
	config: Record<string, unknown>;
	/** Polling configuration */
	poll?: PollConfig;
}

/** Polling configuration for source connectors */
export interface PollConfig {
	/** Poll interval (e.g., "5m", "30s", "1h") */
	interval: string;
}

/** Actor (target) connector configuration */
export interface ActorConfig {
	/** Actor ID assigned in the project config */
	id: string;
	/** Reference to the connector package */
	connector: string;
	/** Connector-specific configuration */
	config: Record<string, unknown>;
}

/** Route definition — when/then/with wiring */
export interface RouteDefinition {
	/** Route name (unique within a route group) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** Trigger: when should this route fire? */
	when: RouteWhen;
	/** Transform pipeline to apply before delivery */
	transforms?: RouteTransformRef[];
	/** Target: where to deliver the event */
	then: RouteThen;
	/** Launch context: situational instructions */
	with?: RouteWith;
}

/** Route trigger definition */
export interface RouteWhen {
	/** Source ID to match */
	source: string;
	/** Event types to match */
	events: string[];
	/** Additional filter criteria (dot-path field matching) */
	filter?: Record<string, unknown>;
}

/** Reference to a transform in a route */
export interface RouteTransformRef {
	/** Transform name/ref */
	ref: string;
	/** Optional transform-specific config override */
	config?: Record<string, unknown>;
	/** Error policy override: what to do when this transform fails (overrides definition-level on_error) */
	on_error?: TransformErrorPolicy;
}

/** Route delivery target */
export interface RouteThen {
	/** Actor ID to deliver to */
	actor: string;
	/** Actor-specific delivery config */
	config?: Record<string, unknown>;
	/** Delivery configuration (rate limit, retry, circuit breaker) */
	delivery?: DeliveryConfig;
}

/** Delivery configuration for advanced routing */
export interface DeliveryConfig {
	max_rate?: string;
	queue_depth?: number;
	retry?: RetryConfig;
	circuit_breaker?: CircuitBreakerConfig;
}

/** Retry configuration */
export interface RetryConfig {
	max_attempts: number;
	backoff: 'exponential' | 'linear' | 'fixed';
	initial_delay: string;
	max_delay: string;
}

/** Circuit breaker configuration */
export interface CircuitBreakerConfig {
	failure_threshold: number;
	cooldown: string;
}

/** Route launch context — situational SOPs */
export interface RouteWith {
	/** Path to a Markdown SOP file (relative to route YAML) */
	prompt_file: string;
}

/** Route delivery config passed to ActorConnector.deliver() */
export interface RouteDeliveryConfig {
	/** Actor-specific config from route's then.config */
	[key: string]: unknown;
	/** Resolved launch prompt text (from route's with.prompt_file, front matter stripped) */
	launch_prompt?: string;
	/** Original prompt file path (for reference/logging) */
	launch_prompt_file?: string;
	/** Parsed front matter metadata from prompt file, or null if none */
	launch_prompt_meta?: Record<string, unknown> | null;
}

/** Error policy for transforms — controls behavior when a transform throws */
export type TransformErrorPolicy = 'pass' | 'drop' | 'halt';

/** Transform definition (YAML) */
export interface TransformDefinition {
	/** Transform name */
	name: string;
	/** Transform type */
	type: 'script' | 'package';
	/** Script path (for type: script) */
	script?: string;
	/** Package name (for type: package) */
	package?: string;
	/** Transform-specific configuration */
	config?: Record<string, unknown>;
	/** Timeout in milliseconds (default: 30000) */
	timeout_ms?: number;
	/** Error policy: pass (fail-open, default), drop (fail-closed), halt (stop pipeline) */
	on_error?: TransformErrorPolicy;
}

/** Logger definition (YAML) */
export interface LoggerDefinition {
	/** Logger name */
	name: string;
	/** Logger type (package reference) */
	type: string;
	/** Logger-specific configuration */
	config: Record<string, unknown>;
}

// ─── Log Entry ────────────────────────────────────────────────────────────────

/** Pipeline phase identifiers */
export type LogPhase =
	| 'source.emit'
	| 'source.circuit_open'
	| 'source.circuit_retry'
	| 'source.circuit_close'
	| 'transform.start'
	| 'transform.pass'
	| 'transform.drop'
	| 'transform.error'
	| 'transform.error_drop'
	| 'transform.error_halt'
	| 'route.match'
	| 'route.no_match'
	| 'deliver.attempt'
	| 'deliver.success'
	| 'deliver.failure'
	| 'deliver.retry'
	| 'system.start'
	| 'system.stop'
	| 'system.error'
	| 'module.loading'
	| 'module.active'
	| 'module.unloading'
	| 'module.removed'
	| 'module.error'
	| 'runtime.start'
	| 'runtime.stop';

/** Universal log entry — every logger receives this */
export interface LogEntry {
	/** ISO 8601 timestamp (UTC) */
	timestamp: string;
	/** Unique event ID */
	event_id: string;
	/** Trace ID grouping all entries for one event's journey */
	trace_id: string;
	/** Pipeline phase */
	phase: LogPhase;
	/** Source ID */
	source?: string;
	/** Actor ID */
	target?: string;
	/** Route name */
	route?: string;
	/** Transform name */
	transform?: string;
	/** Event type */
	event_type?: string;
	/** Phase-specific result */
	result?: string;
	/** Phase duration in milliseconds */
	duration_ms?: number;
	/** Current queue depth (for backpressure visibility) */
	queue_depth?: number;
	/** Error message if applicable */
	error?: string;
	/** Additional context */
	metadata?: Record<string, unknown>;
	/** Runtime version */
	orgloop_version?: string;
	/** Machine hostname */
	hostname?: string;
	/** Active workspace name */
	workspace?: string;
	/** Module name that generated this log entry */
	module?: string;
}

// ─── Project Configuration ────────────────────────────────────────────────────

/** Root orgloop.yaml project configuration */
export interface ProjectConfig {
	apiVersion: string;
	kind: 'Project';
	metadata: {
		name: string;
		description?: string;
	};
	defaults?: {
		poll_interval?: string;
		event_retention?: string;
		log_level?: string;
	};
	connectors?: string[];
	transforms?: string[];
	loggers?: string[];
	/** Installed modules with their parameter values */
	modules?: Array<{
		package: string;
		params: Record<string, string | number | boolean>;
	}>;
}

/** Full resolved OrgLoop configuration — everything needed to run */
export interface OrgLoopConfig {
	/** Project metadata */
	project: {
		name: string;
		description?: string;
	};
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
	/** Global defaults */
	defaults?: {
		poll_interval?: string;
		event_retention?: string;
		log_level?: string;
	};
	/** Data directory for WAL, checkpoints, etc. */
	data_dir?: string;
}

/** Source instance config (resolved from YAML) */
export interface SourceInstanceConfig {
	/** Source ID */
	id: string;
	/** Description */
	description?: string;
	/** Labels for filtering/grouping */
	labels?: Record<string, string>;
	/** Connector package reference */
	connector: string;
	/** Connector-specific config */
	config: Record<string, unknown>;
	/** Polling config */
	poll?: PollConfig;
	/** What event types this source emits */
	emits?: string[];
}

/** Actor instance config (resolved from YAML) */
export interface ActorInstanceConfig {
	/** Actor ID */
	id: string;
	/** Description */
	description?: string;
	/** Labels for filtering/grouping */
	labels?: Record<string, string>;
	/** Connector package reference */
	connector: string;
	/** Connector-specific config */
	config: Record<string, unknown>;
}

// ─── Source Health ─────────────────────────────────────────────────────────────

/** Health status of a source connector */
export type SourceHealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/** Per-source health state tracked by the engine */
export interface SourceHealthState {
	/** Source connector ID */
	sourceId: string;
	/** Current health status */
	status: SourceHealthStatus;
	/** Timestamp of last successful poll (ISO 8601) */
	lastSuccessfulPoll: string | null;
	/** Timestamp of last poll attempt (ISO 8601) */
	lastPollAttempt: string | null;
	/** Number of consecutive poll failures */
	consecutiveErrors: number;
	/** Last error message (null if last poll succeeded) */
	lastError: string | null;
	/** Total events emitted by this source */
	totalEventsEmitted: number;
	/** Whether the circuit breaker is open (polling paused) */
	circuitOpen: boolean;
}

// ─── Event Bus ────────────────────────────────────────────────────────────────

/** Event filter for subscriptions */
export interface EventFilter {
	/** Filter by source ID */
	source?: string;
	/** Filter by event type */
	type?: OrgLoopEventType;
	/** Filter by route name */
	route?: string;
}

/** Event handler function */
export type EventHandler = (event: OrgLoopEvent) => Promise<void>;

/** Subscription handle */
export interface Subscription {
	unsubscribe(): void;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Duration string (e.g., "5m", "30s", "1h", "7d") */
export type DurationString = string;

// ─── Module Runtime Types ─────────────────────────────────────────────────────

/** Module lifecycle states */
export type ModuleState = 'loading' | 'active' | 'unloading' | 'removed';

/** Module status information */
export interface ModuleStatus {
	name: string;
	state: ModuleState;
	sources: number;
	routes: number;
	actors: number;
	uptime_ms: number;
	health: SourceHealthState[];
}

/** Runtime status information */
export interface RuntimeStatus {
	running: boolean;
	pid: number;
	uptime_ms: number;
	httpPort?: number;
	modules: ModuleStatus[];
}

/** Boot manifest module entry */
export interface BootModuleEntry {
	/** npm package name or local path */
	package: string;
	/** Parameter values for template expansion */
	params: Record<string, string | number | boolean>;
}

/** Boot manifest (orgloop.yaml for multi-module mode) */
export interface RuntimeConfig {
	/** Modules to load at boot */
	modules: BootModuleEntry[];
	/** Shared runtime defaults */
	defaults?: {
		poll_interval?: string;
		log_level?: string;
	};
	/** Runtime-level loggers (shared across all modules) */
	loggers?: LoggerDefinition[];
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Parse a duration string to milliseconds */
export function parseDuration(duration: DurationString): number {
	const match = duration.match(/^(\d+)(ms|s|m|h|d)$/);
	if (!match) {
		throw new Error(
			`Invalid duration format: "${duration}". Expected format: <number><unit> (e.g., 5m, 30s, 1h, 7d)`,
		);
	}
	const value = Number.parseInt(match[1], 10);
	const unit = match[2];
	switch (unit) {
		case 'ms':
			return value;
		case 's':
			return value * 1000;
		case 'm':
			return value * 60 * 1000;
		case 'h':
			return value * 60 * 60 * 1000;
		case 'd':
			return value * 24 * 60 * 60 * 1000;
		default:
			throw new Error(`Unknown duration unit: ${unit}`);
	}
}
