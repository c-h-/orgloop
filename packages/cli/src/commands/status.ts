/**
 * orgloop status — Show runtime status.
 *
 * Tries control API first (GET /control/status) for module-aware display,
 * falls back to PID-based status if control API is not available.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModuleStatus, RuntimeStatus, SourceHealthState } from '@orgloop/sdk';
import chalk from 'chalk';
import type { Command } from 'commander';
import { loadCliConfig } from '../config.js';
import * as output from '../output.js';

const PID_DIR = join(homedir(), '.orgloop');
const PID_FILE = join(PID_DIR, 'orgloop.pid');
const PORT_FILE = join(PID_DIR, 'runtime.port');
const STATE_FILE = join(PID_DIR, 'state.json');
const LOG_FILE = join(PID_DIR, 'logs', 'orgloop.log');

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function formatUptime(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) return `${days}d ${hours % 24}h`;
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}

interface LogEntry {
	timestamp: string;
	event_id: string;
	phase: string;
	source?: string;
	event_type?: string;
	route?: string;
	result?: string;
}

function healthStatusColor(status: string): string {
	switch (status) {
		case 'healthy':
			return chalk.green(status);
		case 'degraded':
			return chalk.yellow(status);
		case 'unhealthy':
			return chalk.red(status);
		default:
			return status;
	}
}

function formatTimeAgo(isoTimestamp: string | null): string {
	if (!isoTimestamp) return '—';
	const ms = Date.now() - new Date(isoTimestamp).getTime();
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

async function getRecentEvents(count: number): Promise<LogEntry[]> {
	try {
		const content = await readFile(LOG_FILE, 'utf-8');
		const lines = content.trim().split('\n').filter(Boolean);
		const entries: LogEntry[] = [];

		for (const line of lines.slice(-count * 3)) {
			try {
				const entry = JSON.parse(line) as LogEntry;
				if (
					entry.phase === 'deliver.success' ||
					entry.phase === 'deliver.failure' ||
					entry.phase === 'transform.drop'
				) {
					entries.push(entry);
				}
			} catch {
				/* skip malformed */
			}
		}

		return entries.slice(-count);
	} catch {
		return [];
	}
}

async function tryControlApiStatus(port: number): Promise<RuntimeStatus | null> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/control/status`, {
			signal: AbortSignal.timeout(3_000),
		});
		if (res.ok) {
			return (await res.json()) as RuntimeStatus;
		}
	} catch {
		// Control API not reachable
	}
	return null;
}

function displayModuleHealth(mod: ModuleStatus): void {
	const unhealthy = mod.health.filter((h) => h.status !== 'healthy');
	if (unhealthy.length > 0) {
		output.blank();
		for (const h of unhealthy) {
			if (h.circuitOpen) {
				output.warn(
					`${h.sourceId}: polling paused after ${h.consecutiveErrors} consecutive failures`,
				);
			} else {
				output.warn(
					`${h.sourceId}: ${h.consecutiveErrors} consecutive error${h.consecutiveErrors !== 1 ? 's' : ''}`,
				);
			}
			if (h.lastError) {
				output.info(`    Last error: ${h.lastError}`);
			}
		}
	}
}

function displayRuntimeStatus(runtimeStatus: RuntimeStatus): void {
	output.blank();
	output.heading('OrgLoop Runtime');
	output.info(`  Status: ${chalk.green('running')} (PID ${runtimeStatus.pid})`);
	output.info(`  Uptime: ${formatUptime(runtimeStatus.uptime_ms)}`);
	if (runtimeStatus.httpPort) {
		output.info(`  Control API: http://127.0.0.1:${runtimeStatus.httpPort}`);
	}
	output.info(`  Modules: ${runtimeStatus.modules.length}`);

	for (const mod of runtimeStatus.modules) {
		output.blank();
		output.heading(`Module: ${mod.name}`);
		output.info(`  State: ${mod.state} | Uptime: ${formatUptime(mod.uptime_ms)}`);
		output.info(`  Sources: ${mod.sources} | Actors: ${mod.actors} | Routes: ${mod.routes}`);

		// Source health table
		if (mod.health.length > 0) {
			output.table(
				[
					{ header: 'SOURCE', key: 'name', width: 16 },
					{ header: 'HEALTH', key: 'health', width: 12 },
					{ header: 'LAST POLL', key: 'lastPoll', width: 12 },
					{ header: 'ERRORS', key: 'errors', width: 8 },
					{ header: 'EVENTS', key: 'events', width: 8 },
				],
				mod.health.map((h) => ({
					name: h.sourceId,
					health: healthStatusColor(h.status),
					lastPoll: formatTimeAgo(h.lastSuccessfulPoll),
					errors: String(h.consecutiveErrors),
					events: String(h.totalEventsEmitted),
				})),
			);
		}

		displayModuleHealth(mod);
	}
}

export function registerStatusCommand(program: Command): void {
	program
		.command('status')
		.description('Show runtime status')
		.action(async (_opts, cmd) => {
			try {
				const globalOpts = cmd.parent?.opts() ?? {};

				// Check if running
				let pid: number | null = null;
				let running = false;

				try {
					const pidStr = await readFile(PID_FILE, 'utf-8');
					pid = Number.parseInt(pidStr.trim(), 10);
					running = !Number.isNaN(pid) && isProcessRunning(pid);
				} catch {
					/* no pid file */
				}

				if (!running) {
					if (output.isJsonMode()) {
						output.json({ running: false });
					} else {
						output.info('OrgLoop is not running.');
						output.info('Run `orgloop start` to start.');
					}
					return;
				}

				// Try to get status from control API first
				let runtimeStatus: RuntimeStatus | null = null;
				try {
					const portStr = await readFile(PORT_FILE, 'utf-8');
					const port = Number.parseInt(portStr.trim(), 10);
					if (!Number.isNaN(port)) {
						runtimeStatus = await tryControlApiStatus(port);
					}
				} catch {
					// No port file — fall through to PID-based status
				}

				if (runtimeStatus) {
					if (output.isJsonMode()) {
						output.json(runtimeStatus);
						return;
					}

					displayRuntimeStatus(runtimeStatus);

					// Recent events
					const recentEvents = await getRecentEvents(5);
					if (recentEvents.length > 0) {
						output.blank();
						output.heading('Recent Events (last 5):');
						output.table(
							[
								{ header: 'TIME', key: 'time', width: 14 },
								{ header: 'SOURCE', key: 'source', width: 12 },
								{ header: 'TYPE', key: 'type', width: 20 },
								{ header: 'ROUTE', key: 'route', width: 30 },
								{ header: 'STATUS', key: 'status', width: 16 },
							],
							recentEvents.map((e) => {
								const time = new Date(e.timestamp).toLocaleTimeString('en-US', {
									hour12: false,
								});
								return {
									time,
									source: e.source ?? '—',
									type: e.event_type ?? '—',
									route: e.route ?? '—',
									status: e.result ?? e.phase.split('.')[1] ?? '—',
								};
							}),
						);
					}

					output.blank();
					return;
				}

				// Fallback: PID-based status (no control API available)
				let config: import('@orgloop/sdk').OrgLoopConfig | null = null;
				try {
					config = await loadCliConfig({ configPath: globalOpts.config });
				} catch {
					/* ignore — config not loadable */
				}

				// Try to read health from state file
				let healthData: SourceHealthState[] = [];
				try {
					const content = await readFile(STATE_FILE, 'utf-8');
					const state = JSON.parse(content);
					if (state.modules && Array.isArray(state.modules)) {
						// New format: aggregate health from all modules
						for (const mod of state.modules as ModuleStatus[]) {
							healthData.push(...mod.health);
						}
					} else if (Array.isArray(state.health)) {
						// Legacy format
						healthData = state.health as SourceHealthState[];
					}
				} catch {
					// No state file
				}

				if (output.isJsonMode()) {
					output.json({
						running: true,
						pid,
						project: config?.project.name ?? 'unknown',
						sources: config?.sources.length ?? 0,
						actors: config?.actors.length ?? 0,
						routes: config?.routes.length ?? 0,
						health: healthData,
					});
					return;
				}

				output.blank();
				output.heading(`OrgLoop — ${config?.project.name ?? 'unknown'}`);
				output.info(`  Status: running (PID ${pid})`);
				output.info('  Control API: not available');

				// Sources table with health
				if (config && config.sources.length > 0) {
					const healthMap = new Map(healthData.map((h) => [h.sourceId, h]));

					output.table(
						[
							{ header: 'NAME', key: 'name', width: 16 },
							{ header: 'TYPE', key: 'type', width: 8 },
							{ header: 'HEALTH', key: 'health', width: 12 },
							{ header: 'LAST POLL', key: 'lastPoll', width: 12 },
							{ header: 'ERRORS', key: 'errors', width: 8 },
							{ header: 'EVENTS', key: 'events', width: 8 },
						],
						config.sources.map((s) => {
							const h = healthMap.get(s.id);
							return {
								name: s.id,
								type: s.poll ? 'poll' : 'hook',
								health: h ? healthStatusColor(h.status) : chalk.dim('—'),
								lastPoll: h ? formatTimeAgo(h.lastSuccessfulPoll) : '—',
								errors: h ? String(h.consecutiveErrors) : '—',
								events: h ? String(h.totalEventsEmitted) : '—',
							};
						}),
					);
				}

				// Show warnings for unhealthy sources
				const unhealthy = healthData.filter((h) => h.status !== 'healthy');
				if (unhealthy.length > 0) {
					output.blank();
					for (const h of unhealthy) {
						if (h.circuitOpen) {
							output.warn(
								`${h.sourceId}: polling paused after ${h.consecutiveErrors} consecutive failures`,
							);
						} else {
							output.warn(
								`${h.sourceId}: ${h.consecutiveErrors} consecutive error${h.consecutiveErrors !== 1 ? 's' : ''}`,
							);
						}
						if (h.lastError) {
							output.info(`    Last error: ${h.lastError}`);
						}
					}
				}

				// Actors table
				if (config && config.actors.length > 0) {
					output.blank();
					output.table(
						[
							{ header: 'NAME', key: 'name', width: 24 },
							{ header: 'STATUS', key: 'status', width: 12 },
						],
						config.actors.map((a) => ({
							name: a.id,
							status: 'healthy',
						})),
					);
				}

				// Routes table
				if (config && config.routes.length > 0) {
					output.blank();
					output.table(
						[
							{ header: 'NAME', key: 'name', width: 32 },
							{ header: 'SOURCE', key: 'source', width: 16 },
							{ header: 'ACTOR', key: 'actor', width: 20 },
						],
						config.routes.map((r) => ({
							name: r.name,
							source: r.when.source,
							actor: r.then.actor,
						})),
					);
				}

				// Recent events
				const recentEvents = await getRecentEvents(5);
				if (recentEvents.length > 0) {
					output.blank();
					output.heading('Recent Events (last 5):');
					output.table(
						[
							{ header: 'TIME', key: 'time', width: 14 },
							{ header: 'SOURCE', key: 'source', width: 12 },
							{ header: 'TYPE', key: 'type', width: 20 },
							{ header: 'ROUTE', key: 'route', width: 30 },
							{ header: 'STATUS', key: 'status', width: 16 },
						],
						recentEvents.map((e) => {
							const time = new Date(e.timestamp).toLocaleTimeString('en-US', {
								hour12: false,
							});
							return {
								time,
								source: e.source ?? '—',
								type: e.event_type ?? '—',
								route: e.route ?? '—',
								status: e.result ?? e.phase.split('.')[1] ?? '—',
							};
						}),
					);
				}

				output.blank();
			} catch (err) {
				output.error(`Status failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});
}
