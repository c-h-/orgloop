/**
 * orgloop validate — Validate configuration files.
 *
 * Checks YAML syntax, schema conformance, reference integrity,
 * transform script existence/permissions, and prompt file existence.
 */

import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type {
	ActorInstanceConfig,
	LoggerDefinition,
	ProjectConfig,
	RouteDefinition,
	SourceInstanceConfig,
	TransformDefinition,
} from '@orgloop/sdk';
import chalk from 'chalk';
import type { Command } from 'commander';
import yaml from 'js-yaml';
import { resolveConfigPath } from '../config.js';
import * as output from '../output.js';
import { createProjectImport } from '../project-import.js';
import { scanEnvVars } from './env.js';

// ─── Validation result ───────────────────────────────────────────────────────

export interface ValidationResult {
	file: string;
	valid: boolean;
	description: string;
	errors: string[];
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

async function loadYaml(path: string): Promise<unknown> {
	const content = await readFile(path, 'utf-8');
	return yaml.load(content);
}

// ─── Validators ──────────────────────────────────────────────────────────────

async function validateYamlSyntax(filePath: string): Promise<ValidationResult> {
	const relPath = filePath;
	try {
		await loadYaml(filePath);
		return { file: relPath, valid: true, description: 'valid YAML syntax', errors: [] };
	} catch (err) {
		return {
			file: relPath,
			valid: false,
			description: 'YAML syntax error',
			errors: [err instanceof Error ? err.message : String(err)],
		};
	}
}

function validateProjectSchema(data: unknown, filePath: string): ValidationResult {
	const errors: string[] = [];
	const project = data as Record<string, unknown>;

	if (!project.apiVersion) errors.push('Missing required field: apiVersion');
	if (project.kind !== 'Project') errors.push(`Expected kind "Project", got "${project.kind}"`);
	if (!project.metadata) {
		errors.push('Missing required field: metadata');
	} else {
		const meta = project.metadata as Record<string, unknown>;
		if (!meta.name) errors.push('Missing required field: metadata.name');
	}

	return {
		file: filePath,
		valid: errors.length === 0,
		description: errors.length === 0 ? 'valid project manifest' : 'invalid project manifest',
		errors,
	};
}

async function validateReferences(
	_basePath: string,
	routesDir: string,
	_project: ProjectConfig,
	sources: Map<string, SourceInstanceConfig>,
	actors: Map<string, ActorInstanceConfig>,
	transforms: Map<string, TransformDefinition>,
	routes: RouteDefinition[],
): Promise<ValidationResult[]> {
	const results: ValidationResult[] = [];

	for (const route of routes) {
		const errors: string[] = [];

		// Check source reference
		if (!sources.has(route.when.source)) {
			const available = [...sources.keys()];
			const suggestion = findClosestMatch(route.when.source, available);
			const msg = `Source "${route.when.source}" not found`;
			errors.push(suggestion ? `${msg}. Did you mean "${suggestion}"?` : msg);
		}

		// Check actor reference
		if (!actors.has(route.then.actor)) {
			const available = [...actors.keys()];
			const suggestion = findClosestMatch(route.then.actor, available);
			const msg = `Actor "${route.then.actor}" not found`;
			errors.push(suggestion ? `${msg}. Did you mean "${suggestion}"?` : msg);
		}

		// Check transform references
		if (route.transforms) {
			for (const tRef of route.transforms) {
				if (!transforms.has(tRef.ref)) {
					const available = [...transforms.keys()];
					const suggestion = findClosestMatch(tRef.ref, available);
					const msg = `Transform "${tRef.ref}" not found`;
					errors.push(suggestion ? `${msg}. Did you mean "${suggestion}"?` : msg);
				}
			}
		}

		// Check prompt file existence
		if (route.with?.prompt_file) {
			const promptPath = isAbsolute(route.with.prompt_file)
				? route.with.prompt_file
				: resolve(routesDir, route.with.prompt_file);
			if (!(await fileExists(promptPath))) {
				errors.push(`Prompt file not found: ${route.with.prompt_file}`);
			}
		}

		results.push({
			file: `route: ${route.name}`,
			valid: errors.length === 0,
			description:
				errors.length === 0 ? 'valid route definition' : `error in route "${route.name}"`,
			errors,
		});
	}

	return results;
}

async function validateTransformScripts(
	transformDirs: Map<string, string>,
	defaultBasePath: string,
	transforms: TransformDefinition[],
): Promise<ValidationResult[]> {
	const results: ValidationResult[] = [];

	for (const t of transforms) {
		if (t.type === 'script' && t.script) {
			const base = transformDirs.get(t.name) ?? defaultBasePath;
			const scriptPath = isAbsolute(t.script) ? t.script : resolve(base, t.script);
			const errors: string[] = [];

			if (!(await fileExists(scriptPath))) {
				errors.push(`Script not found: ${t.script}`);
			} else if (!(await isExecutable(scriptPath))) {
				errors.push(`Script not executable: ${t.script} (run: chmod +x ${t.script})`);
			}

			results.push({
				file: `transform: ${t.name}`,
				valid: errors.length === 0,
				description:
					errors.length === 0 ? `valid ${t.type} transform` : `invalid transform "${t.name}"`,
				errors,
			});
		}
	}

	return results;
}

async function validateTransformConfigs(
	transforms: TransformDefinition[],
	importFn: (specifier: string) => Promise<{ [key: string]: unknown }>,
): Promise<ValidationResult[]> {
	const results: ValidationResult[] = [];

	for (const t of transforms) {
		if (t.type === 'package' && t.package && t.config) {
			try {
				const mod = await importFn(t.package);
				if (typeof mod.register !== 'function') continue;

				const reg = mod.register();
				if (!reg.configSchema) continue;

				const AjvMod = await import('ajv');
				const AjvClass = AjvMod.default?.default ?? AjvMod.default ?? AjvMod;
				const ajv = new AjvClass({ allErrors: true });
				const validate = ajv.compile(reg.configSchema);
				const errors: string[] = [];

				if (!validate(t.config)) {
					for (const e of validate.errors ?? []) {
						errors.push(`${e.instancePath || '/'}: ${e.message}`);
					}
				}

				results.push({
					file: `transform: ${t.name}`,
					valid: errors.length === 0,
					description:
						errors.length === 0
							? `valid ${t.type} transform config`
							: `invalid config for transform "${t.name}"`,
					errors,
				});
			} catch {
				// Package not available — skip config validation (already caught elsewhere)
			}
		}
	}

	return results;
}

function findClosestMatch(target: string, candidates: string[]): string | null {
	if (candidates.length === 0) return null;

	let bestMatch: string | null = null;
	let bestScore = Number.POSITIVE_INFINITY;

	for (const candidate of candidates) {
		const score = levenshtein(target, candidate);
		if (score < bestScore && score <= Math.max(target.length, candidate.length) * 0.5) {
			bestScore = score;
			bestMatch = candidate;
		}
	}

	return bestMatch;
}

function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);

	for (let i = 0; i <= m; i++) dp[i][0] = i;
	for (let j = 0; j <= n; j++) dp[0][j] = j;

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
		}
	}

	return dp[m][n];
}

// ─── Route graph validation ──────────────────────────────────────────────────

export interface GraphWarning {
	kind: 'dead-source' | 'unreachable-actor' | 'orphan-transform' | 'event-type-mismatch';
	id: string;
	message: string;
}

export function validateRouteGraph(
	sources: Map<string, SourceInstanceConfig>,
	actors: Map<string, ActorInstanceConfig>,
	transforms: Map<string, TransformDefinition>,
	routes: RouteDefinition[],
): GraphWarning[] {
	const warnings: GraphWarning[] = [];

	// Collect IDs referenced by routes
	const referencedSources = new Set<string>();
	const referencedActors = new Set<string>();
	const referencedTransforms = new Set<string>();

	for (const route of routes) {
		referencedSources.add(route.when.source);
		referencedActors.add(route.then.actor);
		if (route.transforms) {
			for (const t of route.transforms) {
				referencedTransforms.add(t.ref);
			}
		}
	}

	// Dead sources — defined but not referenced by any route
	for (const id of sources.keys()) {
		if (!referencedSources.has(id)) {
			warnings.push({
				kind: 'dead-source',
				id,
				message: `Source "${id}" is defined but not referenced by any route`,
			});
		}
	}

	// Unreachable actors — defined but not referenced by any route
	for (const id of actors.keys()) {
		if (!referencedActors.has(id)) {
			warnings.push({
				kind: 'unreachable-actor',
				id,
				message: `Actor "${id}" is defined but not referenced by any route`,
			});
		}
	}

	// Orphan transforms — defined but not referenced by any route
	for (const name of transforms.keys()) {
		if (!referencedTransforms.has(name)) {
			warnings.push({
				kind: 'orphan-transform',
				id: name,
				message: `Transform "${name}" is defined but not referenced by any route`,
			});
		}
	}

	// Event type coverage — routes referencing event types not in source's emits list
	for (const route of routes) {
		const source = sources.get(route.when.source);
		if (!source?.emits || source.emits.length === 0) continue;

		for (const eventType of route.when.events) {
			if (!source.emits.includes(eventType)) {
				warnings.push({
					kind: 'event-type-mismatch',
					id: route.name,
					message: `Route "${route.name}" listens for "${eventType}" but source "${route.when.source}" only emits [${source.emits.join(', ')}]`,
				});
			}
		}
	}

	return warnings;
}

// ─── Main validation logic ───────────────────────────────────────────────────

interface ConnectorYaml {
	sources?: SourceInstanceConfig[];
	actors?: ActorInstanceConfig[];
}

interface TransformYaml {
	transforms?: TransformDefinition[];
}

interface LoggerYaml {
	loggers?: LoggerDefinition[];
}

interface RouteYaml {
	routes?: RouteDefinition[];
}

export interface EnvWarning {
	name: string;
	source: string;
}

export async function runValidation(configPath: string): Promise<{
	results: ValidationResult[];
	errorCount: number;
	warnCount: number;
	graphWarnings: GraphWarning[];
	envWarnings: EnvWarning[];
}> {
	const results: ValidationResult[] = [];
	const basePath = dirname(resolve(configPath));

	// 1. Validate orgloop.yaml syntax + schema
	const syntaxResult = await validateYamlSyntax(configPath);
	if (!syntaxResult.valid) {
		results.push(syntaxResult);
		return { results, errorCount: 1, warnCount: 0, graphWarnings: [], envWarnings: [] };
	}

	const projectData = await loadYaml(configPath);
	const schemaResult = validateProjectSchema(projectData, configPath);
	results.push(schemaResult);

	if (!schemaResult.valid) {
		return { results, errorCount: 1, warnCount: 0, graphWarnings: [], envWarnings: [] };
	}

	const project = projectData as ProjectConfig;

	// 2. Load and validate connector files
	const sources = new Map<string, SourceInstanceConfig>();
	const actors = new Map<string, ActorInstanceConfig>();

	for (const file of project.connectors ?? []) {
		const filePath = isAbsolute(file) ? file : resolve(basePath, file);
		const syntaxRes = await validateYamlSyntax(filePath);
		if (!syntaxRes.valid) {
			results.push(syntaxRes);
			continue;
		}

		try {
			const data = (await loadYaml(filePath)) as ConnectorYaml;
			if (data?.sources) {
				for (const s of data.sources) sources.set(s.id, s);
			}
			if (data?.actors) {
				for (const a of data.actors) actors.set(a.id, a);
			}
			results.push({
				file: file,
				valid: true,
				description: data?.sources ? 'valid source definition' : 'valid actor definition',
				errors: [],
			});
		} catch (err) {
			results.push({
				file: file,
				valid: false,
				description: 'failed to load connector file',
				errors: [err instanceof Error ? err.message : String(err)],
			});
		}
	}

	// 3. Load and validate transform files
	const transforms = new Map<string, TransformDefinition>();
	const transformDirs = new Map<string, string>();
	for (const file of project.transforms ?? []) {
		const filePath = isAbsolute(file) ? file : resolve(basePath, file);
		const fileDir = dirname(filePath);
		const syntaxRes = await validateYamlSyntax(filePath);
		if (!syntaxRes.valid) {
			results.push(syntaxRes);
			continue;
		}

		try {
			const data = (await loadYaml(filePath)) as TransformYaml;
			if (data?.transforms) {
				for (const t of data.transforms) {
					transforms.set(t.name, t);
					transformDirs.set(t.name, fileDir);
				}
			}
			results.push({ file: file, valid: true, description: 'valid transform group', errors: [] });
		} catch (err) {
			results.push({
				file: file,
				valid: false,
				description: 'failed to load transform file',
				errors: [err instanceof Error ? err.message : String(err)],
			});
		}
	}

	// 4. Validate transform scripts
	const scriptResults = await validateTransformScripts(transformDirs, basePath, [
		...transforms.values(),
	]);
	results.push(...scriptResults);

	// 4b. Validate package transform configs against their schemas
	const projectImport = createProjectImport(basePath);
	const configResults = await validateTransformConfigs([...transforms.values()], projectImport);
	results.push(...configResults);

	// 5. Load and validate logger files
	for (const file of project.loggers ?? []) {
		const filePath = isAbsolute(file) ? file : resolve(basePath, file);
		const syntaxRes = await validateYamlSyntax(filePath);
		if (!syntaxRes.valid) {
			results.push(syntaxRes);
			continue;
		}

		try {
			const _data = (await loadYaml(filePath)) as LoggerYaml;
			results.push({ file: file, valid: true, description: 'valid logger group', errors: [] });
		} catch (err) {
			results.push({
				file: file,
				valid: false,
				description: 'failed to load logger file',
				errors: [err instanceof Error ? err.message : String(err)],
			});
		}
	}

	// 6. Load and validate route files
	const allRoutes: RouteDefinition[] = [];
	const routesDir = resolve(basePath, 'routes');
	if (await fileExists(routesDir)) {
		const { readdir } = await import('node:fs/promises');
		const files = await readdir(routesDir);
		for (const file of files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))) {
			const filePath = resolve(routesDir, file);
			const syntaxRes = await validateYamlSyntax(filePath);
			if (!syntaxRes.valid) {
				results.push(syntaxRes);
				continue;
			}

			try {
				const data = (await loadYaml(filePath)) as RouteYaml;
				if (data?.routes) allRoutes.push(...data.routes);
				results.push({
					file: `routes/${file}`,
					valid: true,
					description: 'valid route group',
					errors: [],
				});
			} catch (err) {
				results.push({
					file: `routes/${file}`,
					valid: false,
					description: 'failed to load route file',
					errors: [err instanceof Error ? err.message : String(err)],
				});
			}
		}
	}

	// 7. Validate reference integrity
	const refResults = await validateReferences(
		basePath,
		routesDir,
		project,
		sources,
		actors,
		transforms,
		allRoutes,
	);
	results.push(...refResults);

	// 8. Validate route graph (warnings only)
	const graphWarnings = validateRouteGraph(sources, actors, transforms, allRoutes);

	// 9. Scan for missing environment variables (warnings only)
	const envWarnings: EnvWarning[] = [];
	try {
		const envVars = await scanEnvVars(configPath);
		for (const [name, source] of envVars) {
			if (process.env[name] === undefined) {
				envWarnings.push({ name, source });
			}
		}
	} catch {
		// env var scanning is best-effort — don't fail validation
	}

	const errorCount = results.filter((r) => !r.valid).length;
	return {
		results,
		errorCount,
		warnCount: graphWarnings.length + envWarnings.length,
		graphWarnings,
		envWarnings,
	};
}

// ─── Command registration ────────────────────────────────────────────────────

export function registerValidateCommand(program: Command): void {
	program
		.command('validate')
		.description('Validate configuration files')
		.action(async (_opts, cmd) => {
			try {
				const globalOpts = cmd.parent?.opts() ?? {};
				const configPath = resolveConfigPath(globalOpts.config);

				if (!(await fileExists(configPath))) {
					output.error(`Configuration file not found: ${configPath}`);
					process.exitCode = 1;
					return;
				}

				const { results, errorCount, warnCount, graphWarnings, envWarnings } =
					await runValidation(configPath);

				if (output.isJsonMode()) {
					output.json({
						results,
						errors: errorCount,
						warnings: warnCount,
						graphWarnings,
						envWarnings,
					});
					if (errorCount > 0) process.exitCode = 2;
					return;
				}

				output.blank();
				for (const r of results) {
					if (r.valid) {
						output.validPass(r.file, r.description);
					} else {
						output.validFail(r.file, r.description);
						for (const err of r.errors) {
							output.info(`    ${err}`);
						}
					}
				}

				// Display route graph warnings
				if (graphWarnings.length > 0) {
					output.blank();
					for (const w of graphWarnings) {
						output.validWarn(w.id, w.message);
					}
				}

				// Display missing env var warnings
				if (envWarnings.length > 0) {
					output.blank();
					for (const ew of envWarnings) {
						output.warn(`${ew.name} \u2014 not set ${chalk.dim(`(${ew.source})`)}`);
					}
				}

				output.blank();
				if (errorCount === 0) {
					output.info(`0 errors, ${warnCount} warnings \u2713`);
					output.info(chalk.dim('Next: run `orgloop doctor` for a full health check.'));
				} else {
					output.info(
						`${errorCount} error${errorCount > 1 ? 's' : ''}, ${warnCount} warning${warnCount > 1 ? 's' : ''}`,
					);
					output.info(chalk.dim('Fix the errors above, then re-run `orgloop validate`.'));
					process.exitCode = 2;
				}
			} catch (err) {
				output.error(`Validation failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});
}
