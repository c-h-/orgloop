/**
 * Module resolution — loads installed modules, expands templates, returns routes.
 *
 * Modules are a config-time concept. The engine never sees modules — only
 * concrete routes after expansion. This resolver bridges the gap.
 */

import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ModuleExpansionContext, ModuleManifest, RouteDefinition } from '@orgloop/sdk';
import { expandTemplateDeep, moduleManifestSchema } from '@orgloop/sdk';
import AjvModule from 'ajv';
import type { ErrorObject } from 'ajv';
import yaml from 'js-yaml';

const Ajv = AjvModule.default ?? AjvModule;

/** An installed module entry from orgloop.yaml */
export interface InstalledModuleEntry {
	package: string;
	params: Record<string, string | number | boolean>;
}

/** Result of resolving a single module */
export interface ResolvedModule {
	manifest: ModuleManifest;
	routes: RouteDefinition[];
	modulePath: string;
}

/**
 * Expand short module names to full package names.
 *
 * - `engineering` → `@orgloop/module-engineering`
 * - `minimal`     → `@orgloop/module-minimal`
 * - `@orgloop/module-foo` → unchanged
 * - `./local/path` → unchanged
 */
export function expandModuleName(name: string): string {
	// Already a path or scoped package — return as-is
	if (name.startsWith('.') || name.startsWith('/') || name.startsWith('@')) {
		return name;
	}
	// Bare name → expand to @orgloop/module-<name>
	return `@orgloop/module-${name}`;
}

/**
 * Resolve a module package to a filesystem path.
 *
 * Supports:
 * - Short names: `engineering` → `@orgloop/module-engineering` → resolved via Node
 * - Scoped packages: `@orgloop/module-engineering` → resolved via Node
 * - Local paths: `./modules/engineering` → resolved relative to basePath
 */
export function resolveModulePath(pkg: string, basePath: string): string {
	// Local path (starts with . or /)
	if (pkg.startsWith('.') || pkg.startsWith('/')) {
		return isAbsolute(pkg) ? pkg : resolve(basePath, pkg);
	}

	// Expand short names (e.g. "engineering" → "@orgloop/module-engineering")
	const fullPkg = expandModuleName(pkg);

	// npm/workspace package — try to resolve via Node's module resolution
	try {
		const resolved = import.meta.resolve?.(`${fullPkg}/orgloop-module.yaml`);
		if (resolved) {
			// import.meta.resolve returns a file:// URL
			const filePath = new URL(resolved).pathname;
			return dirname(filePath);
		}
	} catch {
		// Fall through
	}

	// Fallback: try common monorepo locations
	const candidates = [
		resolve(basePath, 'node_modules', fullPkg),
		resolve(basePath, '..', 'modules', fullPkg.replace(/^@orgloop\/module-/, '')),
	];

	// Return first candidate (existence will be checked by caller)
	return candidates[0];
}

/**
 * Load and validate a module manifest from a directory.
 */
export async function loadModuleManifest(modulePath: string): Promise<ModuleManifest> {
	const manifestPath = join(modulePath, 'orgloop-module.yaml');

	let content: string;
	try {
		content = await readFile(manifestPath, 'utf-8');
	} catch {
		throw new Error(
			`Module manifest not found: ${manifestPath}\nEnsure the module package contains an orgloop-module.yaml file.`,
		);
	}

	const parsed = yaml.load(content) as unknown;

	// Validate against schema
	const ajv = new Ajv({ allErrors: true });
	const validate = ajv.compile(moduleManifestSchema);
	if (!validate(parsed)) {
		const errors = (validate.errors ?? [])
			.map((e: ErrorObject) => `${e.instancePath || '/'}: ${e.message}`)
			.join(', ');
		throw new Error(`Invalid module manifest at ${manifestPath}: ${errors}`);
	}

	return parsed as ModuleManifest;
}

/**
 * Load route templates from a module and expand them with params.
 */
export async function expandModuleRoutes(
	modulePath: string,
	manifest: ModuleManifest,
	params: Record<string, string | number | boolean>,
): Promise<RouteDefinition[]> {
	const templatePath = join(modulePath, 'templates', 'routes.yaml');

	let content: string;
	try {
		content = await readFile(templatePath, 'utf-8');
	} catch {
		// Module has no route templates — that's fine
		return [];
	}

	// Build expansion context, applying defaults for missing params
	const resolvedParams: Record<string, string | number | boolean> = {};
	for (const paramDef of manifest.parameters ?? []) {
		if (params[paramDef.name] !== undefined) {
			resolvedParams[paramDef.name] = params[paramDef.name];
		} else if (paramDef.default !== undefined) {
			resolvedParams[paramDef.name] = paramDef.default;
		} else if (paramDef.required) {
			throw new Error(
				`Missing required parameter "${paramDef.name}" for module "${manifest.metadata.name}"`,
			);
		}
	}

	const context: ModuleExpansionContext = {
		module: {
			name: manifest.metadata.name,
			path: modulePath,
		},
		params: resolvedParams,
	};

	// Expand the template content string first (handles {{ }} in YAML values)
	const expandedYaml = content.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expr: string) => {
		const parts = expr.split('.');
		if (parts.length !== 2) return _match;
		const [namespace, key] = parts;
		if (namespace === 'module') {
			return String(context.module[key as keyof ModuleExpansionContext['module']] ?? _match);
		}
		if (namespace === 'params') {
			return String(context.params[key] ?? _match);
		}
		return _match;
	});

	const parsed = yaml.load(expandedYaml) as { routes?: RouteDefinition[] } | null;

	return parsed?.routes ?? [];
}

/**
 * Resolve all modules from orgloop.yaml and return their expanded routes.
 */
export async function resolveModules(
	modules: InstalledModuleEntry[],
	basePath: string,
): Promise<{ routes: RouteDefinition[]; resolved: ResolvedModule[] }> {
	const allRoutes: RouteDefinition[] = [];
	const resolved: ResolvedModule[] = [];

	for (const mod of modules) {
		const modulePath = resolveModulePath(mod.package, basePath);
		const manifest = await loadModuleManifest(modulePath);
		const routes = await expandModuleRoutes(modulePath, manifest, mod.params);

		allRoutes.push(...routes);
		resolved.push({ manifest, routes, modulePath });
	}

	return { routes: allRoutes, resolved };
}
