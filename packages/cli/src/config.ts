/**
 * CLI configuration loading — thin pass-through to core's loadConfig with
 * CLI-friendly defaults: route auto-discovery, lenient missing-file handling,
 * user-defaults merging.
 */

import { access, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { loadConfig } from '@orgloop/core';
import type { OrgLoopConfig, ProjectConfig } from '@orgloop/sdk';
import yaml from 'js-yaml';

export interface CliConfigOptions {
	/** Path to orgloop.yaml (from --config flag) */
	configPath?: string;
	/** Workspace name */
	workspace?: string;
}

/**
 * Resolve the config file path.
 * Priority: --config flag > ./orgloop.yaml.
 */
export function resolveConfigPath(configPath?: string): string {
	if (configPath) {
		return isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);
	}
	return resolve(process.cwd(), 'orgloop.yaml');
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Load and resolve the full OrgLoop configuration from YAML files.
 *
 * Delegates to core `loadConfig` with CLI-friendly flags:
 *   autoDiscoverRoutes: true, lenient: true, mergeUserDefaults: true.
 */
export async function loadCliConfig(options: CliConfigOptions = {}): Promise<OrgLoopConfig> {
	const configPath = resolveConfigPath(options.configPath);
	if (!(await fileExists(configPath))) {
		throw new Error(
			`Configuration file not found: ${configPath}\nRun \`orgloop init\` to create a new project, or use --config to specify a path.`,
		);
	}
	return loadConfig({
		configPath,
		autoDiscoverRoutes: true,
		lenient: true,
		mergeUserDefaults: true,
	});
}

/**
 * Load the raw ProjectConfig (for validation/display without full resolution).
 */
export async function loadProjectConfig(configPath?: string): Promise<ProjectConfig> {
	const resolved = resolveConfigPath(configPath);
	if (!(await fileExists(resolved))) {
		throw new Error(`Configuration file not found: ${resolved}`);
	}
	const content = await readFile(resolved, 'utf-8');
	return yaml.load(content) as ProjectConfig;
}
