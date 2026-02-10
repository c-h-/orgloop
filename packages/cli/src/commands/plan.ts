/**
 * orgloop plan — Show what would change.
 *
 * Compares desired state (YAML config) vs current running state.
 * Shows: + new, ~ changed, = unchanged, - removed.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OrgLoopConfig } from '@orgloop/sdk';
import type { Command } from 'commander';
import { loadCliConfig, resolveConfigPath } from '../config.js';
import * as output from '../output.js';

// ─── Running state ───────────────────────────────────────────────────────────

interface RunningState {
	sources: Record<string, { connector: string; poll_interval?: string }>;
	actors: Record<string, { connector: string }>;
	routes: Record<string, { source: string; actor: string }>;
	transforms: Record<string, { type: string }>;
	loggers: Record<string, { type: string }>;
}

async function loadRunningState(): Promise<RunningState | null> {
	const pidDir = join(homedir(), '.orgloop');
	const pidFile = join(pidDir, 'orgloop.pid');

	// Only use saved state if the engine is actually running
	try {
		const pidContent = await readFile(pidFile, 'utf-8');
		const pid = Number.parseInt(pidContent.trim(), 10);
		process.kill(pid, 0); // Throws if process doesn't exist
	} catch {
		return null; // No running engine — everything is new
	}

	const stateFile = join(pidDir, 'state.json');
	try {
		const content = await readFile(stateFile, 'utf-8');
		return JSON.parse(content) as RunningState;
	} catch {
		return null;
	}
}

// ─── Plan computation ────────────────────────────────────────────────────────

type PlanAction = 'add' | 'change' | 'unchanged' | 'remove';

interface PlanItem {
	name: string;
	action: PlanAction;
	detail?: string;
}

function computePlan(
	config: OrgLoopConfig,
	running: RunningState | null,
): {
	sources: PlanItem[];
	actors: PlanItem[];
	routes: PlanItem[];
	transforms: PlanItem[];
	loggers: PlanItem[];
	summary: { add: number; change: number; remove: number };
} {
	const sources: PlanItem[] = [];
	const actors: PlanItem[] = [];
	const routes: PlanItem[] = [];
	const transforms: PlanItem[] = [];
	const loggers: PlanItem[] = [];

	let add = 0;
	let change = 0;
	let remove = 0;

	// Sources
	const runSources = running?.sources ?? {};
	for (const s of config.sources) {
		if (!runSources[s.id]) {
			const interval = s.poll?.interval ? `poll every ${s.poll.interval}` : 'hook';
			sources.push({ name: s.id, action: 'add', detail: `new — ${interval}` });
			add++;
		} else {
			// Simple change detection: compare connector + poll interval
			const rs = runSources[s.id];
			if (rs.connector !== s.connector || rs.poll_interval !== s.poll?.interval) {
				sources.push({ name: s.id, action: 'change', detail: 'changed' });
				change++;
			} else {
				sources.push({ name: s.id, action: 'unchanged', detail: 'unchanged' });
			}
		}
	}
	for (const id of Object.keys(runSources)) {
		if (!config.sources.find((s) => s.id === id)) {
			sources.push({ name: id, action: 'remove', detail: 'removed' });
			remove++;
		}
	}

	// Actors
	const runActors = running?.actors ?? {};
	for (const a of config.actors) {
		if (!runActors[a.id]) {
			actors.push({ name: a.id, action: 'add', detail: 'new' });
			add++;
		} else {
			const ra = runActors[a.id];
			if (ra.connector !== a.connector) {
				actors.push({ name: a.id, action: 'change', detail: 'changed' });
				change++;
			} else {
				actors.push({ name: a.id, action: 'unchanged', detail: 'unchanged' });
			}
		}
	}
	for (const id of Object.keys(runActors)) {
		if (!config.actors.find((a) => a.id === id)) {
			actors.push({ name: id, action: 'remove', detail: 'removed' });
			remove++;
		}
	}

	// Routes
	const runRoutes = running?.routes ?? {};
	for (const r of config.routes) {
		if (!runRoutes[r.name]) {
			routes.push({ name: r.name, action: 'add', detail: 'new' });
			add++;
		} else {
			const rr = runRoutes[r.name];
			if (rr.source !== r.when.source || rr.actor !== r.then.actor) {
				routes.push({ name: r.name, action: 'change', detail: 'changed' });
				change++;
			} else {
				routes.push({ name: r.name, action: 'unchanged', detail: 'unchanged' });
			}
		}
	}
	for (const name of Object.keys(runRoutes)) {
		if (!config.routes.find((r) => r.name === name)) {
			routes.push({ name, action: 'remove', detail: 'removed' });
			remove++;
		}
	}

	// Transforms
	const runTransforms = running?.transforms ?? {};
	for (const t of config.transforms) {
		if (!runTransforms[t.name]) {
			transforms.push({ name: t.name, action: 'add', detail: `new — ${t.type}` });
			add++;
		} else {
			transforms.push({ name: t.name, action: 'unchanged', detail: 'unchanged' });
		}
	}
	for (const name of Object.keys(runTransforms)) {
		if (!config.transforms.find((t) => t.name === name)) {
			transforms.push({ name, action: 'remove', detail: 'removed' });
			remove++;
		}
	}

	// Loggers
	const runLoggers = running?.loggers ?? {};
	for (const l of config.loggers) {
		if (!runLoggers[l.name]) {
			loggers.push({ name: l.name, action: 'add', detail: 'new' });
			add++;
		} else {
			loggers.push({ name: l.name, action: 'unchanged', detail: 'unchanged' });
		}
	}
	for (const name of Object.keys(runLoggers)) {
		if (!config.loggers.find((l) => l.name === name)) {
			loggers.push({ name, action: 'remove', detail: 'removed' });
			remove++;
		}
	}

	return { sources, actors, routes, transforms, loggers, summary: { add, change, remove } };
}

// ─── Display ─────────────────────────────────────────────────────────────────

function displayPlanSection(label: string, items: PlanItem[]): void {
	if (items.length === 0) return;
	output.subheading(label);

	for (const item of items) {
		const detail = item.detail ? ` (${item.detail})` : '';
		const text = `${item.name.padEnd(24)}${detail}`;

		switch (item.action) {
			case 'add':
				output.planAdd(text);
				break;
			case 'change':
				output.planChange(text);
				break;
			case 'unchanged':
				output.planUnchanged(text);
				break;
			case 'remove':
				output.planRemove(text);
				break;
		}
	}
}

// ─── Command registration ────────────────────────────────────────────────────

export function registerPlanCommand(program: Command): void {
	program
		.command('plan')
		.description('Show what would change (dry run)')
		.action(async (_opts, cmd) => {
			try {
				const globalOpts = cmd.parent?.opts() ?? {};
				const config = await loadCliConfig({ configPath: globalOpts.config });
				const running = await loadRunningState();

				const plan = computePlan(config, running);

				if (output.isJsonMode()) {
					output.json(plan);
					return;
				}

				output.blank();
				output.heading(`OrgLoop Plan — ${config.project.name}`);

				displayPlanSection('Sources', plan.sources);
				displayPlanSection('Actors', plan.actors);
				displayPlanSection('Routes', plan.routes);
				displayPlanSection('Transforms', plan.transforms);
				displayPlanSection('Loggers', plan.loggers);

				output.blank();
				output.info(
					`Plan: ${plan.summary.add} to add, ${plan.summary.change} to change, ${plan.summary.remove} to remove.`,
				);
				output.blank();

				if (plan.summary.add > 0 || plan.summary.change > 0 || plan.summary.remove > 0) {
					output.info('Run `orgloop apply` to execute this plan.');
				}
			} catch (err) {
				output.error(`Plan failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});
}
