/**
 * Module types for OrgLoop.
 *
 * A module is a bundled workflow: connectors + routes + transforms + SOPs —
 * installable as a single npm package. Modules reference connectors; they
 * don't create them. Users wire connectors; modules declare what they need.
 */

// ─── Module Manifest ──────────────────────────────────────────────────────────

/** Inline source connector definition in a module manifest */
export interface ModuleSourceDefinition {
	id: string;
	connector: string;
	config: Record<string, unknown>;
	poll?: { interval: string };
}

/** Inline actor connector definition in a module manifest */
export interface ModuleActorDefinition {
	id: string;
	connector: string;
	config: Record<string, unknown>;
}

/** Inline connector definitions for a self-contained module */
export interface ModuleConnectors {
	sources?: ModuleSourceDefinition[];
	actors?: ModuleActorDefinition[];
}

/** Root module manifest (orgloop-module.yaml) */
export interface ModuleManifest {
	apiVersion: string;
	kind: 'Module';
	metadata: ModuleMetadata;
	requires?: ModuleRequirements;
	parameters?: ModuleParameter[];
	provides?: ModuleProvides;
	/** Inline connector definitions (for self-contained modules) */
	connectors?: ModuleConnectors;
}

/** Module metadata */
export interface ModuleMetadata {
	name: string;
	description: string;
	version: string;
}

/** What the module requires to function */
export interface ModuleRequirements {
	connectors?: ModuleConnectorRequirement[];
	services?: ModuleServiceRequirement[];
	credentials?: ModuleCredentialRequirement[];
	hooks?: ModuleHookRequirement[];
}

/** A connector the module needs */
export interface ModuleConnectorRequirement {
	type: 'source' | 'actor';
	id: string;
	connector: string;
	required?: boolean;
	fallback?: 'queue' | 'skip';
}

/** A service dependency (informational for doctor/orgctl) */
export interface ModuleServiceRequirement {
	name: string;
	detect?: { http?: string };
	install?: { brew?: string; docs?: string };
	provides_credentials?: string[];
}

/** A credential the module needs (informational for doctor/orgctl) */
export interface ModuleCredentialRequirement {
	name: string;
	description: string;
	required?: boolean;
	create_url?: string;
	validate?: string;
}

/** A hook requirement (informational for doctor/orgctl) */
export interface ModuleHookRequirement {
	type: string;
	required?: boolean;
	scope?: 'global' | 'project';
}

/** A parameter the user provides when installing the module */
export interface ModuleParameter {
	name: string;
	description: string;
	type: 'string' | 'number' | 'boolean';
	required?: boolean;
	default?: string | number | boolean;
}

/** What the module provides (informational) */
export interface ModuleProvides {
	routes?: number;
	transforms?: number;
	sops?: number;
}

// ─── Installed Module Reference ───────────────────────────────────────────────

/** A module entry in orgloop.yaml's modules: array */
export interface InstalledModule {
	/** npm package name or local path */
	package: string;
	/** User-provided parameter values */
	params: Record<string, string | number | boolean>;
}

// ─── Parameter Expansion ──────────────────────────────────────────────────────

/** Context available during template expansion */
export interface ModuleExpansionContext {
	/** Module metadata */
	module: {
		name: string;
		path: string;
	};
	/** User-provided parameter values */
	params: Record<string, string | number | boolean>;
}

/**
 * Expand `{{ variable }}` placeholders in a string.
 *
 * Supports:
 *   - {{ params.X }}       — user-provided parameter
 *   - {{ module.name }}    — module name from manifest
 *   - {{ module.path }}    — resolved filesystem path to the module
 *
 * Throws if a referenced variable is not found in the context.
 */
export function expandTemplate(template: string, context: ModuleExpansionContext): string {
	return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expr: string) => {
		const parts = expr.split('.');
		if (parts.length !== 2) {
			throw new Error(`Invalid template expression: {{ ${expr} }}`);
		}

		const [namespace, key] = parts;

		if (namespace === 'module') {
			const value = context.module[key as keyof ModuleExpansionContext['module']];
			if (value === undefined) {
				throw new Error(`Unknown module variable: {{ ${expr} }}`);
			}
			return value;
		}

		if (namespace === 'params') {
			const value = context.params[key];
			if (value === undefined) {
				throw new Error(`Missing parameter: {{ ${expr} }}`);
			}
			return String(value);
		}

		throw new Error(`Unknown namespace "${namespace}" in template expression: {{ ${expr} }}`);
	});
}

/**
 * Deep-expand all string values in an object tree.
 * Non-string values pass through unchanged.
 */
export function expandTemplateDeep(value: unknown, context: ModuleExpansionContext): unknown {
	if (typeof value === 'string') {
		return expandTemplate(value, context);
	}
	if (Array.isArray(value)) {
		return value.map((item) => expandTemplateDeep(item, context));
	}
	if (value !== null && typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			result[k] = expandTemplateDeep(v, context);
		}
		return result;
	}
	return value;
}

// ─── Module Manifest JSON Schema ──────────────────────────────────────────────

/** JSON Schema for validating orgloop-module.yaml */
export const moduleManifestSchema = {
	type: 'object',
	required: ['apiVersion', 'kind', 'metadata'],
	properties: {
		apiVersion: { type: 'string' },
		kind: { const: 'Module' },
		metadata: {
			type: 'object',
			required: ['name', 'description', 'version'],
			properties: {
				name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
				description: { type: 'string' },
				version: { type: 'string' },
			},
		},
		requires: {
			type: 'object',
			properties: {
				connectors: {
					type: 'array',
					items: {
						type: 'object',
						required: ['type', 'id', 'connector'],
						properties: {
							type: { enum: ['source', 'actor'] },
							id: { type: 'string' },
							connector: { type: 'string' },
							required: { type: 'boolean' },
							fallback: { enum: ['queue', 'skip'] },
						},
					},
				},
				services: { type: 'array' },
				credentials: { type: 'array' },
				hooks: { type: 'array' },
			},
		},
		parameters: {
			type: 'array',
			items: {
				type: 'object',
				required: ['name', 'description', 'type'],
				properties: {
					name: { type: 'string' },
					description: { type: 'string' },
					type: { enum: ['string', 'number', 'boolean'] },
					required: { type: 'boolean' },
					default: {},
				},
			},
		},
		provides: {
			type: 'object',
			properties: {
				routes: { type: 'number' },
				transforms: { type: 'number' },
				sops: { type: 'number' },
			},
		},
		connectors: {
			type: 'object',
			properties: {
				sources: {
					type: 'array',
					items: {
						type: 'object',
						required: ['id', 'connector', 'config'],
						properties: {
							id: { type: 'string' },
							connector: { type: 'string' },
							config: { type: 'object' },
							poll: {
								type: 'object',
								properties: {
									interval: { type: 'string' },
								},
							},
						},
					},
				},
				actors: {
					type: 'array',
					items: {
						type: 'object',
						required: ['id', 'connector', 'config'],
						properties: {
							id: { type: 'string' },
							connector: { type: 'string' },
							config: { type: 'object' },
						},
					},
				},
			},
		},
	},
} as const;
