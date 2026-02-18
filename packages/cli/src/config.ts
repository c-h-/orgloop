/**
 * Configuration loading for the CLI.
 *
 * Loads orgloop.yaml from --config flag or current directory,
 * resolves environment variables, merges with user defaults.
 */

import { access, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { OrgLoopConfig, ProjectConfig } from '@orgloop/sdk';
import yaml from 'js-yaml';

// ─── Env var substitution ────────────────────────────────────────────────────

function substituteEnvVars(value: unknown): unknown {
	if (typeof value === 'string') {
		return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
			const envVal = process.env[varName];
			if (envVal === undefined) {
				throw new Error(`Environment variable "${varName}" is not set`);
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

// ─── YAML loader ─────────────────────────────────────────────────────────────

async function loadYaml<T>(filePath: string): Promise<T> {
	const content = await readFile(filePath, 'utf-8');
	const parsed = yaml.load(content);
	return substituteEnvVars(parsed) as T;
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

// ─── Connector / Route / Transform / Logger loading ──────────────────────────

interface ConnectorYaml {
	apiVersion?: string;
	kind?: string;
	sources?: OrgLoopConfig['sources'];
	actors?: OrgLoopConfig['actors'];
}

interface RouteYaml {
	apiVersion?: string;
	kind?: string;
	routes?: OrgLoopConfig['routes'];
}

interface TransformYaml {
	apiVersion?: string;
	kind?: string;
	transforms?: OrgLoopConfig['transforms'];
}

interface LoggerYaml {
	apiVersion?: string;
	kind?: string;
	loggers?: OrgLoopConfig['loggers'];
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface CliConfigOptions {
	/** Path to orgloop.yaml (from --config flag) */
	configPath?: string;
	/** Workspace name */
	workspace?: string;
}

/**
 * Resolve the config file path.
 * Priority: --config flag > ./orgloop.yaml > error.
 */
export function resolveConfigPath(configPath?: string): string {
	if (configPath) {
		return isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);
	}
	return resolve(process.cwd(), 'orgloop.yaml');
}

/**
 * Load and resolve the full OrgLoop configuration from YAML files.
 */
export async function loadCliConfig(options: CliConfigOptions = {}): Promise<OrgLoopConfig> {
	const configPath = resolveConfigPath(options.configPath);

	if (!(await fileExists(configPath))) {
		throw new Error(
			`Configuration file not found: ${configPath}\nRun \`orgloop init\` to create a new project, or use --config to specify a path.`,
		);
	}

	const basePath = resolve(configPath, '..');
	const project = await loadYaml<ProjectConfig>(configPath);

	// Load connector files
	const sources: OrgLoopConfig['sources'] = [];
	const actors: OrgLoopConfig['actors'] = [];

	for (const file of project.connectors ?? []) {
		const filePath = isAbsolute(file) ? file : resolve(basePath, file);
		if (await fileExists(filePath)) {
			const data = await loadYaml<ConnectorYaml>(filePath);
			if (data?.sources) sources.push(...data.sources);
			if (data?.actors) actors.push(...data.actors);
		}
	}

	// Load transform files
	const transforms: OrgLoopConfig['transforms'] = [];
	for (const file of project.transforms ?? []) {
		const filePath = isAbsolute(file) ? file : resolve(basePath, file);
		if (await fileExists(filePath)) {
			const data = await loadYaml<TransformYaml>(filePath);
			if (data?.transforms) transforms.push(...data.transforms);
		}
	}

	// Load logger files
	const loggers: OrgLoopConfig['loggers'] = [];
	for (const file of project.loggers ?? []) {
		const filePath = isAbsolute(file) ? file : resolve(basePath, file);
		if (await fileExists(filePath)) {
			const data = await loadYaml<LoggerYaml>(filePath);
			if (data?.loggers) loggers.push(...data.loggers);
		}
	}

	// Auto-discover route files from routes/ directory
	const routes: OrgLoopConfig['routes'] = [];
	const routesDir = resolve(basePath, 'routes');
	if (await fileExists(routesDir)) {
		try {
			const files = await readdir(routesDir);
			for (const file of files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))) {
				const filePath = resolve(routesDir, file);
				const data = await loadYaml<RouteYaml>(filePath);
				if (data?.routes) {
					// Resolve prompt_file paths relative to route YAML
					for (const route of data.routes) {
						if (route.with?.prompt_file) {
							route.with.prompt_file = resolve(routesDir, route.with.prompt_file);
						}
					}
					routes.push(...data.routes);
				}
			}
		} catch {
			// routes dir not readable, skip
		}
	}

	// Merge with user defaults (~/.orgloop/config.yaml)
	const userConfigPath = join(homedir(), '.orgloop', 'config.yaml');
	let userDefaults: Record<string, unknown> = {};
	if (await fileExists(userConfigPath)) {
		try {
			userDefaults = (await loadYaml<Record<string, unknown>>(userConfigPath)) ?? {};
		} catch {
			// ignore user config errors
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
		defaults: {
			...((userDefaults.defaults as Record<string, string>) ?? {}),
			...(project.defaults ?? {}),
		},
	};
}

/**
 * Load the raw ProjectConfig (for validation/display without full resolution).
 */
export async function loadProjectConfig(configPath?: string): Promise<ProjectConfig> {
	const resolved = resolveConfigPath(configPath);
	if (!(await fileExists(resolved))) {
		throw new Error(`Configuration file not found: ${resolved}`);
	}
	return loadYaml<ProjectConfig>(resolved);
}
