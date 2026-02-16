/**
 * orgloop env — Check environment variable configuration.
 *
 * Scans project YAML files for ${VAR_NAME} patterns and reports
 * which variables are set and which are missing.
 */

import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import chalk from 'chalk';
import type { Command } from 'commander';
import yaml from 'js-yaml';
import { resolveConfigPath } from '../config.js';
import { getEnvVarMeta } from '../env-metadata.js';
import * as output from '../output.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EnvVarInfo {
	name: string;
	sourceFile: string;
}

interface ProjectConfig {
	connectors?: string[];
	transforms?: string[];
	loggers?: string[];
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

/**
 * Scan a YAML string for ${VAR_NAME} patterns and collect variable names.
 */
function extractEnvVars(content: string): string[] {
	const vars: string[] = [];
	const matches = content.matchAll(/\$\{([^}]+)\}/g);
	for (const match of matches) {
		vars.push(match[1]);
	}
	return vars;
}

// ─── Core logic (exported for testing) ───────────────────────────────────────

/**
 * Scan all YAML files referenced by a project config for env var references.
 * Returns a Map of variable name -> source file path (relative).
 */
export async function scanEnvVars(configPath: string): Promise<Map<string, string>> {
	const vars = new Map<string, string>();
	const absConfigPath = resolve(configPath);
	const basePath = dirname(absConfigPath);

	// Scan the project file itself
	const projectContent = await readFile(absConfigPath, 'utf-8');
	for (const v of extractEnvVars(projectContent)) {
		vars.set(v, 'orgloop.yaml');
	}

	// Parse project to find referenced files
	const project = yaml.load(projectContent) as ProjectConfig | null;
	if (!project) return vars;

	// Scan connector files
	for (const file of project.connectors ?? []) {
		const filePath = isAbsolute(file) ? file : resolve(basePath, file);
		if (await fileExists(filePath)) {
			const content = await readFile(filePath, 'utf-8');
			for (const v of extractEnvVars(content)) {
				vars.set(v, file);
			}
		}
	}

	// Scan transform files
	for (const file of project.transforms ?? []) {
		const filePath = isAbsolute(file) ? file : resolve(basePath, file);
		if (await fileExists(filePath)) {
			const content = await readFile(filePath, 'utf-8');
			for (const v of extractEnvVars(content)) {
				vars.set(v, file);
			}
		}
	}

	// Scan logger files
	for (const file of project.loggers ?? []) {
		const filePath = isAbsolute(file) ? file : resolve(basePath, file);
		if (await fileExists(filePath)) {
			const content = await readFile(filePath, 'utf-8');
			for (const v of extractEnvVars(content)) {
				vars.set(v, file);
			}
		}
	}

	// Scan route files from routes/ directory
	const routesDir = resolve(basePath, 'routes');
	if (await fileExists(routesDir)) {
		try {
			const files = await readdir(routesDir);
			for (const file of files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))) {
				const filePath = resolve(routesDir, file);
				const content = await readFile(filePath, 'utf-8');
				for (const v of extractEnvVars(content)) {
					vars.set(v, `routes/${file}`);
				}
			}
		} catch {
			// routes dir not readable, skip
		}
	}

	return vars;
}

/**
 * Parse a .env file into key-value pairs.
 * Supports KEY=VALUE lines, # comments, blank lines, and quoted values.
 */
export function parseEnvFile(content: string): Map<string, string> {
	const vars = new Map<string, string>();

	for (const rawLine of content.split('\n')) {
		const line = rawLine.trim();

		// Skip empty lines and comments
		if (!line || line.startsWith('#')) continue;

		const eqIndex = line.indexOf('=');
		if (eqIndex === -1) continue;

		const key = line.slice(0, eqIndex).trim();
		let value = line.slice(eqIndex + 1).trim();

		// Strip surrounding quotes
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		if (key) {
			vars.set(key, value);
		}
	}

	return vars;
}

// ─── Command registration ────────────────────────────────────────────────────

export function registerEnvCommand(program: Command): void {
	const envCmd = program
		.command('env')
		.description('Check environment variable configuration')
		.action(async (_opts, cmd) => {
			await runEnvCheck(cmd, false);
		});

	envCmd
		.command('check')
		.description('Check env vars and exit with code 1 if any are missing')
		.action(async (_opts, cmd) => {
			await runEnvCheck(cmd, true);
		});
}

async function runEnvCheck(cmd: Command, strict: boolean): Promise<void> {
	try {
		// Walk up to find the root command's options
		let root = cmd;
		while (root.parent) root = root.parent;
		const globalOpts = root.opts();
		const configPath = resolveConfigPath(globalOpts.config);

		if (!(await fileExists(configPath))) {
			output.error(`Configuration file not found: ${configPath}`);
			process.exitCode = 1;
			return;
		}

		const vars = await scanEnvVars(configPath);

		if (vars.size === 0) {
			output.info('No environment variables found in configuration.');
			output.info(chalk.dim('Next: run `orgloop validate` to check your config.'));
			return;
		}

		// Check each variable
		let setCount = 0;
		let missingCount = 0;

		// Find max variable name length for alignment
		const maxNameLen = Math.max(...[...vars.keys()].map((k) => k.length));

		if (output.isJsonMode()) {
			const results: Record<
				string,
				{ set: boolean; source: string; description?: string; help_url?: string }
			> = {};
			for (const [name, source] of vars) {
				const isSet = process.env[name] !== undefined;
				const meta = getEnvVarMeta(name);
				results[name] = {
					set: isSet,
					source,
					...(meta?.description ? { description: meta.description } : {}),
					...(meta?.help_url ? { help_url: meta.help_url } : {}),
				};
				if (isSet) setCount++;
				else missingCount++;
			}
			output.json({ variables: results, set: setCount, missing: missingCount });
			if (strict && missingCount > 0) process.exitCode = 1;
			return;
		}

		output.blank();
		output.heading('Environment Variables:');
		output.blank();

		for (const [name, source] of vars) {
			const isSet = process.env[name] !== undefined;
			const paddedName = name.padEnd(maxNameLen);
			if (isSet) {
				setCount++;
				console.log(`  ${chalk.green('\u2713')} ${paddedName}  ${chalk.dim(source)}`);
			} else {
				missingCount++;
				console.log(`  ${chalk.red('\u2717')} ${paddedName}  ${chalk.dim(source)}`);
				const meta = getEnvVarMeta(name);
				if (meta) {
					console.log(`    ${chalk.dim('\u2192')} ${chalk.dim(meta.description)}`);
					if (meta.help_url) {
						console.log(`    ${chalk.dim('\u2192')} ${chalk.dim(meta.help_url)}`);
					}
				}
			}
		}

		const total = setCount + missingCount;
		output.blank();
		if (missingCount === 0) {
			output.info(`${setCount} of ${total} variables set.`);
			output.info(chalk.dim('Next: run `orgloop validate` to check your config.'));
		} else {
			output.info(`${setCount} of ${total} variables set. ${missingCount} missing.`);
			output.info(chalk.dim('Fix missing variables, then run `orgloop validate`.'));
		}

		if (strict && missingCount > 0) {
			process.exitCode = 1;
		}
	} catch (err) {
		output.error(`Environment check failed: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	}
}
