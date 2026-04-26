import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { type ProjectValidationError, validateProject } from '@orgloop/core';
import type {
	ActorInstanceConfig,
	RouteDefinition,
	SourceInstanceConfig,
	TransformDefinition,
} from '@orgloop/sdk';
import chalk from 'chalk';
import type { Command } from 'commander';
import { loadCliConfig, resolveConfigPath } from '../config.js';
import * as output from '../output.js';
import { resolvePlugins } from '../resolve-connectors.js';
import { scanEnvVars } from './env.js';
export interface ValidationDisplayResult {
	file: string;
	valid: boolean;
	description: string;
	errors: string[];
}
function findClosestMatch(target: string, candidates: string[]): string | null {
	if (candidates.length === 0) return null;
	let best: string | null = null;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const c of candidates) {
		const s = levenshtein(target, c);
		if (s < bestScore && s <= Math.max(target.length, c.length) * 0.5) {
			bestScore = s;
			best = c;
		}
	}
	return best;
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
	const referencedSources = new Set<string>();
	const referencedActors = new Set<string>();
	const referencedTransforms = new Set<string>();

	for (const r of routes) {
		referencedSources.add(r.when.source);
		referencedActors.add(r.then.actor);
		for (const t of r.transforms ?? []) referencedTransforms.add(t.ref);
	}

	for (const id of sources.keys()) {
		if (!referencedSources.has(id)) {
			warnings.push({
				kind: 'dead-source',
				id,
				message: `Source "${id}" is defined but not referenced by any route`,
			});
		}
	}
	for (const id of actors.keys()) {
		if (!referencedActors.has(id)) {
			warnings.push({
				kind: 'unreachable-actor',
				id,
				message: `Actor "${id}" is defined but not referenced by any route`,
			});
		}
	}
	for (const name of transforms.keys()) {
		if (!referencedTransforms.has(name)) {
			warnings.push({
				kind: 'orphan-transform',
				id: name,
				message: `Transform "${name}" is defined but not referenced by any route`,
			});
		}
	}
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
function enrichReferenceErrors(
	errors: ProjectValidationError[],
	sources: string[],
	actors: string[],
	transforms: string[],
): ProjectValidationError[] {
	return errors.map((err) => {
		if (err.scope !== 'reference') return err;
		// Heuristic: find the quoted identifier in the message and suggest a near-match.
		const m = err.message.match(/"([^"]+)" not found/);
		if (!m) return err;
		const target = m[1];
		const lower = err.message.toLowerCase();
		const candidates = lower.includes('source ')
			? sources
			: lower.includes('actor ')
				? actors
				: lower.includes('transform ')
					? transforms
					: [];
		const suggestion = findClosestMatch(target, candidates);
		if (!suggestion) return err;
		return { ...err, message: `${err.message}. Did you mean "${suggestion}"?` };
	});
}
export interface EnvWarning {
	name: string;
	source: string;
}

async function collectEnvWarnings(configPath: string): Promise<EnvWarning[]> {
	const out: EnvWarning[] = [];
	try {
		const envVars = await scanEnvVars(configPath);
		for (const [name, src] of envVars) {
			if (process.env[name] === undefined) out.push({ name, source: src });
		}
	} catch {
		// best-effort
	}
	return out;
}
async function fileExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

export async function runValidation(configPath: string): Promise<{
	results: ValidationDisplayResult[];
	errorCount: number;
	warnCount: number;
	graphWarnings: GraphWarning[];
	envWarnings: EnvWarning[];
}> {
	const projectDir = dirname(resolve(configPath));
	const config = await loadCliConfig({ configPath });
	const { registrations, unresolved } = await resolvePlugins(config, projectDir);

	const result = await validateProject({
		config,
		projectDir,
		registrations,
		unresolvedReferences: unresolved,
	});

	const sourceIds = config.sources.map((s) => s.id);
	const actorIds = config.actors.map((a) => a.id);
	const transformNames = config.transforms.map((t) => t.name);
	const enriched = enrichReferenceErrors(result.errors, sourceIds, actorIds, transformNames);

	// Map core errors into the legacy display rows for compatibility with
	// existing CLI output expectations.
	const results: ValidationDisplayResult[] = enriched.map((err) => ({
		file: err.path ?? err.scope,
		valid: false,
		description: err.scope,
		errors: [err.message],
	}));

	// Build maps for graph lint
	const sources = new Map(config.sources.map((s) => [s.id, s]));
	const actors = new Map(config.actors.map((a) => [a.id, a]));
	const transforms = new Map(config.transforms.map((t) => [t.name, t]));
	const graphWarnings = validateRouteGraph(sources, actors, transforms, config.routes);
	const envWarnings = await collectEnvWarnings(configPath);

	const errorCount = enriched.length;
	return {
		results,
		errorCount,
		warnCount: graphWarnings.length + envWarnings.length + (result.warnings?.length ?? 0),
		graphWarnings,
		envWarnings,
	};
}
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
				if (results.length === 0) {
					output.validPass(configPath, 'all checks passed');
				}
				for (const r of results) {
					output.validFail(r.file, r.description);
					for (const err of r.errors) output.info(`    ${err}`);
				}

				if (graphWarnings.length > 0) {
					output.blank();
					for (const w of graphWarnings) output.validWarn(w.id, w.message);
				}

				if (envWarnings.length > 0) {
					output.blank();
					for (const ew of envWarnings) {
						output.warn(`${ew.name} — not set ${chalk.dim(`(${ew.source})`)}`);
					}
				}

				output.blank();
				if (errorCount === 0) {
					output.info(`0 errors, ${warnCount} warnings ✓`);
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
