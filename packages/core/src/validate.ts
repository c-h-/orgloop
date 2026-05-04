/**
 * Project-level validation.
 *
 * Single authority for structural validation of an OrgLoopConfig:
 *   - AJV schema validation
 *   - Reference integrity (sources/actors/transforms in routes)
 *   - Prompt-file existence
 *   - Transform-script existence + executable bit
 *   - Per-instance configSchema validation (connectors, transforms, loggers)
 *
 * Pre-build: this lives in @orgloop/core so library consumers and the CLI
 * share the same validation surface.
 */

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type {
	ConnectorRegistration,
	LoggerRegistration,
	OrgLoopConfig,
	TransformRegistration,
} from '@orgloop/sdk';
import type { ErrorObject, ValidateFunction } from 'ajv';
import AjvModule from 'ajv';

const Ajv = AjvModule.default ?? AjvModule;

// ─── Public types ────────────────────────────────────────────────────────────

export interface ValidationError {
	scope:
		| 'schema'
		| 'reference'
		| 'prompt-file'
		| 'transform-script'
		| 'connector-config'
		| 'transform-config'
		| 'logger-config';
	message: string;
	path?: string;
}

export interface ValidationWarning {
	scope: 'reference' | 'env' | 'route-graph' | string;
	message: string;
	path?: string;
}

export interface ValidationResult {
	valid: boolean;
	errors: ValidationError[];
	warnings: ValidationWarning[];
}

export type PluginRegistration = ConnectorRegistration | TransformRegistration | LoggerRegistration;

export interface ValidateProjectArgs {
	config: OrgLoopConfig;
	projectDir: string;
	registrations: Map<string, PluginRegistration>;
	/** Optional unresolved references (e.g., from CLI's plugin import phase). */
	unresolvedReferences?: string[];
}

// ─── AJV schema for OrgLoopConfig (structural top level) ────────────────────

const orgloopConfigSchema = {
	type: 'object',
	required: ['project', 'sources', 'actors', 'routes', 'transforms', 'loggers'],
	properties: {
		project: {
			type: 'object',
			required: ['name'],
			properties: {
				name: { type: 'string' },
				description: { type: 'string' },
			},
		},
		sources: {
			type: 'array',
			items: {
				type: 'object',
				required: ['id', 'connector'],
				properties: {
					id: { type: 'string' },
					connector: { type: 'string' },
					config: { type: 'object' },
				},
			},
		},
		actors: {
			type: 'array',
			items: {
				type: 'object',
				required: ['id', 'connector'],
				properties: {
					id: { type: 'string' },
					connector: { type: 'string' },
					config: { type: 'object' },
				},
			},
		},
		routes: {
			type: 'array',
			items: {
				type: 'object',
				required: ['name', 'when', 'then'],
				properties: {
					name: { type: 'string' },
					when: {
						type: 'object',
						required: ['source', 'events'],
						properties: {
							source: { type: 'string' },
							events: { type: 'array', items: { type: 'string' } },
						},
					},
					then: {
						type: 'object',
						required: ['actor'],
						properties: {
							actor: { type: 'string' },
						},
					},
				},
			},
		},
		transforms: {
			type: 'array',
			items: {
				type: 'object',
				required: ['name', 'type'],
				properties: {
					name: { type: 'string' },
					type: { type: 'string', enum: ['package', 'script'] },
				},
			},
		},
		loggers: {
			type: 'array',
			items: {
				type: 'object',
				required: ['name', 'type'],
				properties: {
					name: { type: 'string' },
					type: { type: 'string' },
				},
			},
		},
	},
};

// ─── AJV compile cache (per-schema) ──────────────────────────────────────────
//
// Cached by the schema object identity so re-validation under the same
// registration instance reuses the compiled validator.

const compiledSchemaCache = new WeakMap<object, ValidateFunction>();
let sharedAjv: InstanceType<typeof Ajv> | null = null;

function compileSchema(schema: Record<string, unknown>): ValidateFunction {
	const cached = compiledSchemaCache.get(schema);
	if (cached) return cached;
	if (!sharedAjv) sharedAjv = new Ajv({ allErrors: true, strict: false });
	const validator = sharedAjv.compile(schema);
	compiledSchemaCache.set(schema, validator);
	return validator;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined, prefix: string): string[] {
	return (errors ?? []).map((e) => `${prefix}${e.instancePath || '/'}: ${e.message ?? 'invalid'}`);
}

// ─── Namespaced registration key helpers ────────────────────────────────────

export function connectorKey(id: string): string {
	return `connector:${id}`;
}
export function transformKey(name: string): string {
	return `transform:${name}`;
}
export function loggerKey(name: string): string {
	return `logger:${name}`;
}

// ─── Reference integrity ────────────────────────────────────────────────────

function validateReferences(config: OrgLoopConfig): ValidationError[] {
	const errors: ValidationError[] = [];
	const sourceIds = new Set(config.sources.map((s) => s.id));
	const actorIds = new Set(config.actors.map((a) => a.id));
	const transformNames = new Set(config.transforms.map((t) => t.name));

	for (const route of config.routes) {
		if (!sourceIds.has(route.when.source)) {
			errors.push({
				scope: 'reference',
				message: `Route "${route.name}": source "${route.when.source}" not found`,
				path: `routes/${route.name}/when/source`,
			});
		}
		if (!actorIds.has(route.then.actor)) {
			errors.push({
				scope: 'reference',
				message: `Route "${route.name}": actor "${route.then.actor}" not found`,
				path: `routes/${route.name}/then/actor`,
			});
		}
		for (const tRef of route.transforms ?? []) {
			if (!transformNames.has(tRef.ref)) {
				errors.push({
					scope: 'reference',
					message: `Route "${route.name}": transform "${tRef.ref}" not found`,
					path: `routes/${route.name}/transforms`,
				});
			}
		}
	}

	return errors;
}

// ─── Prompt-file existence ──────────────────────────────────────────────────

async function validatePromptFiles(
	config: OrgLoopConfig,
	projectDir: string,
): Promise<ValidationError[]> {
	const errors: ValidationError[] = [];
	for (const route of config.routes) {
		const promptFile = route.with?.prompt_file;
		if (!promptFile) continue;
		const resolved = isAbsolute(promptFile) ? promptFile : resolve(projectDir, promptFile);
		if (!(await fileExists(resolved))) {
			errors.push({
				scope: 'prompt-file',
				message: `Route "${route.name}": prompt file not found: ${promptFile}`,
				path: `routes/${route.name}/with/prompt_file`,
			});
		}
	}
	return errors;
}

// ─── Transform-script existence ─────────────────────────────────────────────

async function validateTransformScripts(
	config: OrgLoopConfig,
	projectDir: string,
): Promise<ValidationError[]> {
	const errors: ValidationError[] = [];
	for (const t of config.transforms) {
		if (t.type !== 'script' || !t.script) continue;
		const scriptPath = isAbsolute(t.script) ? t.script : resolve(projectDir, t.script);
		if (!(await fileExists(scriptPath))) {
			errors.push({
				scope: 'transform-script',
				message: `Transform "${t.name}": script not found: ${t.script}`,
				path: `transforms/${t.name}/script`,
			});
		} else if (!(await isExecutable(scriptPath))) {
			errors.push({
				scope: 'transform-script',
				message: `Transform "${t.name}": script not executable: ${t.script} (run: chmod +x ${t.script})`,
				path: `transforms/${t.name}/script`,
			});
		}
	}
	return errors;
}

// ─── Per-instance configSchema validation ───────────────────────────────────

function isConnectorRegistration(reg: PluginRegistration): reg is ConnectorRegistration {
	return 'source' in reg || 'target' in reg;
}
function isTransformRegistration(reg: PluginRegistration): reg is TransformRegistration {
	return 'transform' in reg;
}
function isLoggerRegistration(reg: PluginRegistration): reg is LoggerRegistration {
	return 'logger' in reg;
}

function validateInstanceConfigs(
	config: OrgLoopConfig,
	registrations: Map<string, PluginRegistration>,
): ValidationError[] {
	const errors: ValidationError[] = [];

	const checkConnectorInstance = (
		instanceConfig: Record<string, unknown> | undefined,
		instanceId: string,
		kind: 'source' | 'actor',
	) => {
		const reg = registrations.get(connectorKey(instanceId));
		if (!reg || !isConnectorRegistration(reg)) return;
		if (!reg.configSchema) return;
		const validate = compileSchema(reg.configSchema);
		if (!validate(instanceConfig ?? {})) {
			for (const msg of formatAjvErrors(validate.errors, `${kind} "${instanceId}" config`)) {
				errors.push({
					scope: 'connector-config',
					message: msg,
					path: `${kind === 'source' ? 'sources' : 'actors'}/${instanceId}`,
				});
			}
		}
	};

	for (const s of config.sources) {
		checkConnectorInstance(s.config as Record<string, unknown>, s.id, 'source');
	}
	for (const a of config.actors) {
		checkConnectorInstance(a.config as Record<string, unknown>, a.id, 'actor');
	}

	for (const t of config.transforms) {
		if (t.type !== 'package') continue;
		const reg = registrations.get(transformKey(t.name));
		if (!reg || !isTransformRegistration(reg)) continue;
		if (!reg.configSchema) continue;
		const validate = compileSchema(reg.configSchema);
		if (!validate(t.config ?? {})) {
			for (const msg of formatAjvErrors(validate.errors, `transform "${t.name}" config`)) {
				errors.push({
					scope: 'transform-config',
					message: msg,
					path: `transforms/${t.name}`,
				});
			}
		}
	}

	for (const l of config.loggers) {
		const reg = registrations.get(loggerKey(l.name));
		if (!reg || !isLoggerRegistration(reg)) continue;
		if (!reg.configSchema) continue;
		const validate = compileSchema(reg.configSchema);
		if (!validate(l.config ?? {})) {
			for (const msg of formatAjvErrors(validate.errors, `logger "${l.name}" config`)) {
				errors.push({
					scope: 'logger-config',
					message: msg,
					path: `loggers/${l.name}`,
				});
			}
		}
	}

	return errors;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function validateProject(args: ValidateProjectArgs): Promise<ValidationResult> {
	const errors: ValidationError[] = [];
	const warnings: ValidationWarning[] = [];

	// 1. Top-level structural schema
	const schemaValidator = compileSchema(orgloopConfigSchema);
	if (!schemaValidator(args.config)) {
		for (const msg of formatAjvErrors(schemaValidator.errors, '')) {
			errors.push({ scope: 'schema', message: msg });
		}
	}

	// 2. Reference integrity
	errors.push(...validateReferences(args.config));

	// 3. Prompt-file existence
	errors.push(...(await validatePromptFiles(args.config, args.projectDir)));

	// 4. Transform-script existence
	errors.push(...(await validateTransformScripts(args.config, args.projectDir)));

	// 5. Per-instance configSchema validation (skip when registrations is empty —
	//    consumers may legitimately call us without resolved plugins).
	if (args.registrations.size > 0) {
		errors.push(...validateInstanceConfigs(args.config, args.registrations));
	}

	// 6. Surface unresolved references as warnings (CLI dynamic-import layer
	//    reports failures here so validate output stays cohesive).
	for (const ref of args.unresolvedReferences ?? []) {
		warnings.push({
			scope: 'reference',
			message: `Plugin "${ref}" could not be resolved (install or check spelling)`,
			path: ref,
		});
	}

	return { valid: errors.length === 0, errors, warnings };
}
