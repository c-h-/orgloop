/**
 * Error taxonomy for OrgLoop.
 *
 * Every error in the system extends OrgLoopError, giving callers
 * a consistent shape to catch and inspect.
 */

export class OrgLoopError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'OrgLoopError';
		this.code = code;
	}
}

export class ConfigError extends OrgLoopError {
	constructor(message: string, options?: ErrorOptions) {
		super('CONFIG_ERROR', message, options);
		this.name = 'ConfigError';
	}
}

export class ConnectorError extends OrgLoopError {
	readonly connectorId: string;

	constructor(connectorId: string, message: string, options?: ErrorOptions) {
		super('CONNECTOR_ERROR', `[${connectorId}] ${message}`, options);
		this.name = 'ConnectorError';
		this.connectorId = connectorId;
	}
}

export class TransformError extends OrgLoopError {
	readonly transformId: string;

	constructor(transformId: string, message: string, options?: ErrorOptions) {
		super('TRANSFORM_ERROR', `[${transformId}] ${message}`, options);
		this.name = 'TransformError';
		this.transformId = transformId;
	}
}

export class DeliveryError extends OrgLoopError {
	readonly actorId: string;
	readonly routeName: string;

	constructor(actorId: string, routeName: string, message: string, options?: ErrorOptions) {
		super('DELIVERY_ERROR', `[${actorId}/${routeName}] ${message}`, options);
		this.name = 'DeliveryError';
		this.actorId = actorId;
		this.routeName = routeName;
	}
}

export class SchemaError extends OrgLoopError {
	readonly validationErrors: string[];

	constructor(message: string, validationErrors: string[] = [], options?: ErrorOptions) {
		super('SCHEMA_ERROR', message, options);
		this.name = 'SchemaError';
		this.validationErrors = validationErrors;
	}
}

export class ModuleConflictError extends OrgLoopError {
	readonly moduleName: string;

	constructor(moduleName: string, message?: string, options?: ErrorOptions) {
		super('MODULE_CONFLICT', message ?? `Module conflict: ${moduleName}`, options);
		this.name = 'ModuleConflictError';
		this.moduleName = moduleName;
	}
}

export class ModuleNotFoundError extends OrgLoopError {
	readonly moduleName: string;

	constructor(moduleName: string, message?: string, options?: ErrorOptions) {
		super('MODULE_NOT_FOUND', message ?? `Module not found: ${moduleName}`, options);
		this.name = 'ModuleNotFoundError';
		this.moduleName = moduleName;
	}
}

export class RuntimeError extends OrgLoopError {
	constructor(message: string, options?: ErrorOptions) {
		super('RUNTIME_ERROR', message, options);
		this.name = 'RuntimeError';
	}
}
