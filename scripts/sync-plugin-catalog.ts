#!/usr/bin/env node
/**
 * sync-plugin-catalog.ts — enforce the four-way invariant between
 * the plugin catalog, workspace package directories, and CLI devDependencies.
 *
 *   1. FS dirs   ⊆ catalog          (every connector/transform/logger dir is listed)
 *   2. catalog   ⊆ FS dirs          (no catalog entry references a missing package)
 *   3. catalog   ⊆ CLI devDeps      (every catalog entry is a CLI dev dep)
 *   4. plugin devDeps ⊆ catalog     (every plugin-style cli devDep is in the catalog)
 *
 * Exits non-zero on violation so CI can gate on it.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_CATALOG } from '../packages/cli/src/plugin-catalog.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const PLUGIN_DEVDEP_RE = /^@orgloop\/(connector|transform|logger)-/;

async function listDirs(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(resolve(REPO_ROOT, dir), { withFileTypes: true });
		return entries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
}

async function readJson(path: string): Promise<Record<string, unknown>> {
	const raw = await readFile(resolve(REPO_ROOT, path), 'utf-8');
	return JSON.parse(raw) as Record<string, unknown>;
}

const HOOK_COMMAND_RE = /hook\s*\.\s*command\(['"]([\w-]+)['"]\)/g;
const ORGLOOP_HOOK_PREFIX = 'orgloop hook ';

async function readSource(path: string): Promise<string> {
	return readFile(resolve(REPO_ROOT, path), 'utf-8');
}

function extractRegisteredHookCommands(source: string): Set<string> {
	const out = new Set<string>();
	for (const match of source.matchAll(HOOK_COMMAND_RE)) {
		out.add(match[1]);
	}
	return out;
}

function extractCatalogHookCommands(): Set<string> {
	const out = new Set<string>();
	for (const entry of PLUGIN_CATALOG) {
		for (const harness of entry.harnesses ?? []) {
			for (const integration of harness.integrations) {
				const cmd = integration.command?.trim();
				if (!cmd?.startsWith(ORGLOOP_HOOK_PREFIX)) continue;
				const subcommand = cmd.slice(ORGLOOP_HOOK_PREFIX.length).split(/\s+/)[0];
				if (subcommand) out.add(subcommand);
			}
		}
	}
	return out;
}

async function checkHookIntegrationsResolve(errors: string[]): Promise<void> {
	let hookSource: string;
	try {
		hookSource = await readSource('packages/cli/src/commands/hook.ts');
	} catch {
		errors.push('Cannot read packages/cli/src/commands/hook.ts');
		return;
	}
	const registered = extractRegisteredHookCommands(hookSource);
	const advertised = extractCatalogHookCommands();
	for (const name of advertised) {
		if (!registered.has(name)) {
			errors.push(
				`PLUGIN_CATALOG advertises "orgloop hook ${name}" but no hook.command('${name}') exists in hook.ts`,
			);
		}
	}
}

async function main(): Promise<void> {
	const errors: string[] = [];

	const fsConnectors = await listDirs('connectors');
	const fsTransforms = await listDirs('transforms');
	const fsLoggers = await listDirs('loggers');

	// Look up package name from each on-disk dir.
	const fsPackageNames = new Set<string>();
	for (const [dir, names] of [
		['connectors', fsConnectors],
		['transforms', fsTransforms],
		['loggers', fsLoggers],
	] as const) {
		for (const name of names) {
			try {
				const pkg = await readJson(`${dir}/${name}/package.json`);
				if (typeof pkg.name === 'string') fsPackageNames.add(pkg.name);
			} catch {
				errors.push(`Cannot read ${dir}/${name}/package.json`);
			}
		}
	}

	const catalogPackageNames = new Set(PLUGIN_CATALOG.map((e) => e.packageName));

	// 1. FS dirs ⊆ catalog
	for (const pkg of fsPackageNames) {
		if (!catalogPackageNames.has(pkg)) {
			errors.push(`Workspace package "${pkg}" exists but is missing from PLUGIN_CATALOG`);
		}
	}

	// 2. catalog ⊆ FS dirs
	for (const pkg of catalogPackageNames) {
		if (!fsPackageNames.has(pkg)) {
			errors.push(`PLUGIN_CATALOG entry "${pkg}" has no corresponding workspace package`);
		}
	}

	// 3+4. CLI devDeps cross-checks
	const cliPkg = await readJson('packages/cli/package.json');
	const devDeps = (cliPkg.devDependencies as Record<string, string> | undefined) ?? {};
	const cliPluginDevDeps = new Set(Object.keys(devDeps).filter((d) => PLUGIN_DEVDEP_RE.test(d)));

	for (const pkg of catalogPackageNames) {
		if (!cliPluginDevDeps.has(pkg)) {
			errors.push(`PLUGIN_CATALOG entry "${pkg}" is missing from @orgloop/cli devDependencies`);
		}
	}
	for (const pkg of cliPluginDevDeps) {
		if (!catalogPackageNames.has(pkg)) {
			errors.push(`@orgloop/cli devDependency "${pkg}" is missing from PLUGIN_CATALOG`);
		}
	}

	// 5. catalog hook integrations ⊆ registered hook subcommands
	await checkHookIntegrationsResolve(errors);

	if (errors.length > 0) {
		console.error('Plugin catalog invariant violations:');
		for (const e of errors) console.error(`  - ${e}`);
		process.exit(1);
	}

	console.log(`Plugin catalog OK (${PLUGIN_CATALOG.length} entries).`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
