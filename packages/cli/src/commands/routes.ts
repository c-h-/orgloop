/**
 * orgloop routes — Visualize the routing topology.
 *
 * Reads the project config and displays an ASCII graph of
 * sources -> routes (with filters/transforms) -> actors.
 * Highlights unrouted sources and unreachable actors.
 *
 * Supports --json for machine-readable graph output.
 */

import type { OrgLoopConfig } from '@orgloop/sdk';
import chalk from 'chalk';
import type { Command } from 'commander';
import { loadCliConfig, resolveConfigPath } from '../config.js';
import * as output from '../output.js';

// ─── Graph data types ─────────────────────────────────────────────────────────

export interface RouteEdge {
	route: string;
	description?: string;
	source: string;
	actor: string;
	events: string[];
	filter?: Record<string, unknown>;
	transforms: string[];
}

export interface RouteGraphWarning {
	kind: 'unrouted-source' | 'unreachable-actor' | 'orphan-transform';
	id: string;
	message: string;
}

export interface RouteGraph {
	project: string;
	sources: string[];
	actors: string[];
	transforms: string[];
	edges: RouteEdge[];
	warnings: RouteGraphWarning[];
}

// ─── Graph building ───────────────────────────────────────────────────────────

export function buildRouteGraph(config: OrgLoopConfig): RouteGraph {
	const sourceIds = config.sources.map((s) => s.id);
	const actorIds = config.actors.map((a) => a.id);
	const transformNames = config.transforms.map((t) => t.name);

	const edges: RouteEdge[] = config.routes.map((route) => ({
		route: route.name,
		description: route.description,
		source: route.when.source,
		actor: route.then.actor,
		events: route.when.events,
		filter: route.when.filter,
		transforms: route.transforms?.map((t) => t.ref) ?? [],
	}));

	// Detect warnings
	const warnings: RouteGraphWarning[] = [];

	const routedSources = new Set(config.routes.map((r) => r.when.source));
	const reachedActors = new Set(config.routes.map((r) => r.then.actor));
	const usedTransforms = new Set(
		config.routes.flatMap((r) => r.transforms?.map((t) => t.ref) ?? []),
	);

	for (const id of sourceIds) {
		if (!routedSources.has(id)) {
			warnings.push({
				kind: 'unrouted-source',
				id,
				message: `Source "${id}" has no routes`,
			});
		}
	}

	for (const id of actorIds) {
		if (!reachedActors.has(id)) {
			warnings.push({
				kind: 'unreachable-actor',
				id,
				message: `Actor "${id}" is not targeted by any route`,
			});
		}
	}

	for (const name of transformNames) {
		if (!usedTransforms.has(name)) {
			warnings.push({
				kind: 'orphan-transform',
				id: name,
				message: `Transform "${name}" is not used by any route`,
			});
		}
	}

	return {
		project: config.project.name,
		sources: sourceIds,
		actors: actorIds,
		transforms: transformNames,
		edges,
		warnings,
	};
}

// ─── ASCII rendering ──────────────────────────────────────────────────────────

function formatFilter(filter: Record<string, unknown>): string {
	return Object.entries(filter)
		.map(([k, v]) => `${k}: ${String(v)}`)
		.join(', ');
}

export function renderRouteGraph(graph: RouteGraph): string {
	const lines: string[] = [];

	lines.push(chalk.bold(`OrgLoop Routes \u2014 ${graph.project}`));
	lines.push('');

	if (graph.edges.length === 0 && graph.warnings.length === 0) {
		lines.push(chalk.dim('  No routes defined.'));
		return lines.join('\n');
	}

	// Group edges by source for a cleaner display
	const edgesBySource = new Map<string, RouteEdge[]>();
	for (const edge of graph.edges) {
		const existing = edgesBySource.get(edge.source) ?? [];
		existing.push(edge);
		edgesBySource.set(edge.source, existing);
	}

	// Render routed sources
	for (const [source, edges] of edgesBySource) {
		for (const edge of edges) {
			const arrow = chalk.dim('\u2500\u2500\u25B6');
			const routeName = chalk.cyan(edge.route);
			const actorName = chalk.green(edge.actor);
			lines.push(`  ${chalk.yellow(source)} ${arrow} ${routeName} ${arrow} ${actorName}`);

			// Filter line
			if (edge.events.length > 0 || edge.filter) {
				const parts: string[] = [];
				if (edge.events.length > 0) {
					parts.push(edge.events.join(', '));
				}
				if (edge.filter) {
					parts.push(formatFilter(edge.filter));
				}
				lines.push(chalk.dim(`                \u2514\u2500 filter: ${parts.join(', ')}`));
			}

			// Transforms line
			if (edge.transforms.length > 0) {
				lines.push(
					chalk.dim(`                \u2514\u2500 transform: ${edge.transforms.join(' \u2192 ')}`),
				);
			}
		}
		lines.push('');
	}

	// Render unrouted sources
	const routedSources = new Set(graph.edges.map((e) => e.source));
	const unroutedSources = graph.sources.filter((s) => !routedSources.has(s));
	for (const source of unroutedSources) {
		lines.push(
			`  ${chalk.yellow(source)} ${chalk.dim('\u2500\u2500\u25B6')} ${chalk.yellow('(no routes)')}  ${chalk.yellow('\u26A0')} unrouted source`,
		);
		lines.push('');
	}

	// Render unreachable actors
	const reachedActors = new Set(graph.edges.map((e) => e.actor));
	const unreachableActors = graph.actors.filter((a) => !reachedActors.has(a));
	if (unreachableActors.length > 0) {
		for (const actor of unreachableActors) {
			lines.push(
				`  ${chalk.yellow('\u26A0')} ${chalk.green(actor)} ${chalk.yellow('\u2014 unreachable actor (no routes target this actor)')}`,
			);
		}
		lines.push('');
	}

	// Summary
	const warningCount = graph.warnings.length;
	if (warningCount > 0) {
		lines.push(
			`${graph.edges.length} route${graph.edges.length !== 1 ? 's' : ''}, ${warningCount} warning${warningCount !== 1 ? 's' : ''}`,
		);
	} else {
		lines.push(
			chalk.dim(`${graph.edges.length} route${graph.edges.length !== 1 ? 's' : ''}, 0 warnings`),
		);
	}

	return lines.join('\n');
}

// ─── Command registration ────────────────────────────────────────────────────

export function registerRoutesCommand(program: Command): void {
	program
		.command('routes')
		.description('Visualize the routing topology')
		.action(async (_opts, cmd) => {
			try {
				const globalOpts = cmd.parent?.opts() ?? {};
				const configPath = resolveConfigPath(globalOpts.config);

				const config = await loadCliConfig({ configPath });
				const graph = buildRouteGraph(config);

				if (output.isJsonMode()) {
					output.json(graph);
					return;
				}

				output.blank();
				output.info(renderRouteGraph(graph));

				if (graph.warnings.length > 0) {
					output.info(chalk.dim('Next: run `orgloop validate` for detailed config checks.'));
				}
			} catch (err) {
				output.error(`Failed to load routes: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});
}
