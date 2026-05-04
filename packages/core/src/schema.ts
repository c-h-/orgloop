/**
 * YAML config loading + JSON Schema validation.
 *
 * Loads orgloop.yaml and all referenced YAML files, resolves ${} env vars,
 * validates against schema, and returns a fully resolved OrgLoopConfig.
 */

import { access, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ErrorObject } from 'ajv';
import AjvModule from 'ajv';
import yaml from 'js-yaml';

const Ajv = AjvModule.default ?? AjvModule;

import type {
	ActorInstanceConfig,
	LoggerDefinition,
	OrgLoopConfig,
	ProjectConfig,
	RouteDefinition,
	SourceInstanceConfig,
	TransformDefinition,
} from '@orgloop/sdk';
import { ConfigError, SchemaError } from './errors.js';

// ─── JSON Schema for project config ──────────────────────────────────────────

const projectSchema = {
	type: 'object',
	required: ['apiVersion', 'kind', 'metadata'],
	properties: {
		apiVersion: { type: 'string' },
		kind: { const: 'Project' },
		metadata: {
			type: 'object',
			required: ['name'],
			properties: {
				name: { type: 'string' },
				description: { type: 'string' },
			},
		},
		defaults: {
			type: 'object',
			properties: {
				poll_interval: { type: 'string' },
				event_retention: { type: 'string' },
				log_level: { type: 'string' },
				checkpoint: {
					type: 'object',
					properties: {
						store: { type: 'string', enum: ['file', 'memory'] },
						dir: { type: 'string' },
					},
				},
			},
		},
		connectors: { type: 'array', items: { type: 'string' } },
		transforms: { type: 'array', items: { type: 'string' } },
		loggers: { type: 'array', items: { type: 'string' } },
	},
};

// ─── Env var substitution ─────────────────────────────────────────────────────

function substituteEnvVars(value: unknown): unknown {
	if (typeof value === 'string') {
		return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
			const envVal = process.env[varName];
			if (envVal === undefined) {
				throw new ConfigError(`Environment variable "${varName}" is not set`);
			}
			return envVal;
		});
	}
	if (Array.isArray(value)) {
		return value.map(substituteEnvVars);
	}
	if (value !== null && typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			result[k] = substituteEnvVars(v);
		}
		return result;
	}
	return value;
}

// ─── YAML file loader ─────────────────────────────────────────────────────────

async function loadYamlFile(filePath: string): Promise<unknown> {
	try {
		const content = await readFile(filePath, 'utf-8');
		const parsed = yaml.load(content);
		return substituteEnvVars(parsed);
	} catch (err) {
		if (err instanceof ConfigError) throw err;
		throw new ConfigError(`Failed to load YAML file: ${filePath}`, { cause: err });
	}
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

// ─── Connector YAML parsing ──────────────────────────────────────────────────

interface ConnectorYaml {
	apiVersion?: string;
	kind?: string;
	sources?: SourceInstanceConfig[];
	actors?: ActorInstanceConfig[];
}

async function loadConnectorFiles(
	basePath: string,
	files: string[],
	lenient: boolean,
): Promise<{ sources: SourceInstanceConfig[]; actors: ActorInstanceConfig[] }> {
	const sources: SourceInstanceConfig[] = [];
	const actors: ActorInstanceConfig[] = [];

	for (const file of files) {
		const filePath = isAbsolute(file) ? file : resolve(basePath, file);
		if (lenient && !(await fileExists(filePath))) continue;
		const data = (await loadYamlFile(filePath)) as ConnectorYaml;
		if (data?.sources) sources.push(...data.sources);
		if (data?.actors) actors.push(...data.actors);
	}
	return { sources, actors };
}

// ─── Transform YAML parsing ──────────────────────────────────────────────────

interface TransformYaml {
	apiVersion?: string;
	kind?: string;
	transforms?: TransformDefinition[];
}

async function loadTransformFiles(
	basePath: string,
	files: string[],
	lenient: boolean,
): Promise<TransformDefinition[]> {
	const transforms: TransformDefinition[] = [];
	for (const file of files) {
		const filePath = isAbsolute(file) ? file : resolve(basePath, file);
		if (lenient && !(await fileExists(filePath))) continue;
		const data = (await loadYamlFile(filePath)) as TransformYaml;
		if (data?.transforms) transforms.push(...data.transforms);
	}
	return transforms;
}

// ─── Logger YAML parsing ─────────────────────────────────────────────────────

interface LoggerYaml {
	apiVersion?: string;
	kind?: string;
	loggers?: LoggerDefinition[];
}

async function loadLoggerFiles(
	basePath: string,
	files: string[],
	lenient: boolean,
): Promise<LoggerDefinition[]> {
	const loggers: LoggerDefinition[] = [];
	for (const file of files) {
		const filePath = isAbsolute(file) ? file : resolve(basePath, file);
		if (lenient && !(await fileExists(filePath))) continue;
		const data = (await loadYamlFile(filePath)) as LoggerYaml;
		if (data?.loggers) loggers.push(...data.loggers);
	}
	return loggers;
}

// ─── Route YAML parsing ──────────────────────────────────────────────────────

interface RouteYaml {
	apiVersion?: string;
	kind?: string;
	routes?: RouteDefinition[];
}

async function loadRouteFile(filePath: string): Promise<RouteDefinition[]> {
	const data = (await loadYamlFile(filePath)) as RouteYaml;
	const routes = data?.routes ?? [];

	// Resolve with.prompt_file paths relative to the route YAML file
	const routeDir = dirname(filePath);
	for (const route of routes) {
		if (route.with?.prompt_file) {
			route.with.prompt_file = resolve(routeDir, route.with.prompt_file);
		}
	}
	return routes;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface LoadConfigOptions {
	/** Path to orgloop.yaml */
	configPath: string;
	/** Additional route YAML files */
	routeFiles?: string[];
	/**
	 * When `routeFiles` is omitted, discover `<configDir>/routes/*.{yaml,yml}`.
	 * Default: false (library safety). The CLI sets this to true.
	 */
	autoDiscoverRoutes?: boolean;
	/**
	 * Silently skip referenced YAML files that don't exist on disk.
	 * Default: false (library throws). The CLI sets this to true so users
	 * can iterate without the loader hard-failing on every typo.
	 */
	lenient?: boolean;
	/**
	 * Merge defaults from `~/.orgloop/config.yaml` under explicit project
	 * defaults. Default: false. The CLI sets this to true.
	 */
	mergeUserDefaults?: boolean;
}

/**
 * Load and validate an OrgLoop configuration from YAML.
 */
export async function loadConfig(options: LoadConfigOptions): Promise<OrgLoopConfig> {
	const {
		configPath,
		routeFiles,
		autoDiscoverRoutes = false,
		lenient = false,
		mergeUserDefaults = false,
	} = options;
	const basePath = dirname(resolve(configPath));

	// Load and validate root config
	const raw = await loadYamlFile(resolve(configPath));
	const ajv = new Ajv({ allErrors: true });
	const validate = ajv.compile(projectSchema);
	if (!validate(raw)) {
		const errors = (validate.errors ?? []).map(
			(e: ErrorObject) => `${e.instancePath || '/'}: ${e.message}`,
		);
		throw new SchemaError('Invalid project configuration', errors);
	}

	const project = raw as unknown as ProjectConfig;

	// Load referenced files
	const { sources, actors } = await loadConnectorFiles(basePath, project.connectors ?? [], lenient);
	const transforms = await loadTransformFiles(basePath, project.transforms ?? [], lenient);
	const loggers = await loadLoggerFiles(basePath, project.loggers ?? [], lenient);

	// Load route files
	const routes: RouteDefinition[] = [];
	if (routeFiles && routeFiles.length > 0) {
		for (const rf of routeFiles) {
			const rfPath = isAbsolute(rf) ? rf : resolve(basePath, rf);
			if (lenient && !(await fileExists(rfPath))) continue;
			routes.push(...(await loadRouteFile(rfPath)));
		}
	} else if (autoDiscoverRoutes) {
		const routesDir = resolve(basePath, 'routes');
		if (await fileExists(routesDir)) {
			try {
				const files = await readdir(routesDir);
				for (const file of files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))) {
					routes.push(...(await loadRouteFile(resolve(routesDir, file))));
				}
			} catch {
				// routes dir not readable
			}
		}
	}

	// Merge user defaults from ~/.orgloop/config.yaml (CLI behavior).
	let mergedDefaults = project.defaults;
	if (mergeUserDefaults) {
		const userConfigPath = join(homedir(), '.orgloop', 'config.yaml');
		if (await fileExists(userConfigPath)) {
			try {
				const userYaml = (await loadYamlFile(userConfigPath)) as
					| { defaults?: Record<string, unknown> }
					| undefined;
				if (userYaml?.defaults) {
					mergedDefaults = {
						...(userYaml.defaults as ProjectConfig['defaults']),
						...(project.defaults ?? {}),
					};
				}
			} catch {
				// ignore user config errors
			}
		}
	}

	return {
		project: {
			name: project.metadata.name,
			description: project.metadata.description,
		},
		sources,
		actors,
		routes,
		transforms,
		loggers,
		defaults: mergedDefaults,
	};
}

/**
 * Build an OrgLoopConfig programmatically (for library/testing use).
 */
export function buildConfig(
	partial: Partial<OrgLoopConfig> & { project: OrgLoopConfig['project'] },
): OrgLoopConfig {
	return {
		project: partial.project,
		sources: partial.sources ?? [],
		actors: partial.actors ?? [],
		routes: partial.routes ?? [],
		transforms: partial.transforms ?? [],
		loggers: partial.loggers ?? [],
		defaults: partial.defaults,
		data_dir: partial.data_dir,
	};
}
