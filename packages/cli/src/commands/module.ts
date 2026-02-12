/**
 * orgloop module — Manage runtime modules.
 *
 * Communicates with a running runtime via HTTP control API to list, inspect,
 * load, unload, and reload modules.
 */

import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import type { Command } from 'commander';
import * as output from '../output.js';

const PORT_FILE = join(homedir(), '.orgloop', 'runtime.port');

async function getControlUrl(): Promise<string> {
	let portStr: string;
	try {
		portStr = await readFile(PORT_FILE, 'utf-8');
	} catch {
		output.error('Runtime is not running. Run `orgloop start` first.');
		process.exit(1);
	}

	const port = Number.parseInt(portStr.trim(), 10);
	if (Number.isNaN(port)) {
		output.error(`Invalid port in ${PORT_FILE}`);
		process.exit(1);
	}

	return `http://127.0.0.1:${port}/control`;
}

function controlRequest(
	method: string,
	url: string,
	body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const payload = body ? JSON.stringify(body) : undefined;

		const req = http.request(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: parsed.pathname,
				method,
				headers: {
					...(payload
						? {
								'Content-Type': 'application/json',
								'Content-Length': Buffer.byteLength(payload),
							}
						: {}),
				},
			},
			(res) => {
				let data = '';
				res.on('data', (chunk: Buffer) => {
					data += chunk.toString();
				});
				res.on('end', () => {
					try {
						const parsed = JSON.parse(data) as Record<string, unknown>;
						resolve({ status: res.statusCode ?? 500, data: parsed });
					} catch {
						resolve({ status: res.statusCode ?? 500, data: { raw: data } });
					}
				});
			},
		);

		req.on('error', (err: Error) => {
			reject(new Error(`Failed to connect to runtime: ${err.message}`));
		});

		if (payload) {
			req.write(payload);
		}
		req.end();
	});
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

function stateColor(state: string): string {
	switch (state) {
		case 'running':
			return chalk.green(state);
		case 'loading':
			return chalk.yellow(state);
		case 'error':
		case 'failed':
			return chalk.red(state);
		case 'stopped':
			return chalk.dim(state);
		default:
			return state;
	}
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

export function registerModuleCommand(program: Command): void {
	const mod = program.command('module').description('Manage runtime modules');

	// ── module list ─────────────────────────────────────────────────────────
	mod
		.command('list')
		.description('List loaded modules')
		.action(async () => {
			try {
				const baseUrl = await getControlUrl();
				const { status, data } = await controlRequest('GET', `${baseUrl}/module/list`);

				if (status !== 200) {
					output.error(
						`Failed to list modules: ${(data as Record<string, unknown>).error ?? `HTTP ${status}`}`,
					);
					process.exitCode = 1;
					return;
				}

				const modules = (data.modules ?? []) as Array<Record<string, unknown>>;

				if (output.isJsonMode()) {
					output.json(data);
					return;
				}

				if (modules.length === 0) {
					output.info('No modules loaded.');
					return;
				}

				output.blank();
				output.heading('Modules');
				output.table(
					[
						{ header: 'NAME', key: 'name', width: 24 },
						{ header: 'STATE', key: 'state', width: 12 },
						{ header: 'SOURCES', key: 'sources', width: 10 },
						{ header: 'ROUTES', key: 'routes', width: 10 },
						{ header: 'ACTORS', key: 'actors', width: 10 },
						{ header: 'UPTIME', key: 'uptime', width: 12 },
					],
					modules.map((m) => ({
						name: String(m.name ?? ''),
						state: stateColor(String(m.state ?? 'unknown')),
						sources: String(m.sources ?? 0),
						routes: String(m.routes ?? 0),
						actors: String(m.actors ?? 0),
						uptime: m.uptime_ms ? formatUptime(Number(m.uptime_ms)) : '—',
					})),
				);
				output.blank();
			} catch (err) {
				output.error(`Module list failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});

	// ── module status <name> ────────────────────────────────────────────────
	mod
		.command('status <name>')
		.description('Show details for a loaded module')
		.action(async (name: string) => {
			try {
				const baseUrl = await getControlUrl();
				const { status, data } = await controlRequest(
					'GET',
					`${baseUrl}/module/status/${encodeURIComponent(name)}`,
				);

				if (status !== 200) {
					output.error(
						`Failed to get module status: ${(data as Record<string, unknown>).error ?? `HTTP ${status}`}`,
					);
					process.exitCode = 1;
					return;
				}

				if (output.isJsonMode()) {
					output.json(data);
					return;
				}

				output.blank();
				output.heading(`Module: ${data.name}`);
				output.info(`  State:  ${stateColor(String(data.state ?? 'unknown'))}`);
				if (data.uptime_ms) {
					output.info(`  Uptime: ${formatUptime(Number(data.uptime_ms))}`);
				}

				// Sources table with health
				const sources = (data.sources ?? []) as Array<Record<string, unknown>>;
				if (sources.length > 0) {
					output.blank();
					output.table(
						[
							{ header: 'SOURCE', key: 'name', width: 24 },
							{ header: 'TYPE', key: 'type', width: 8 },
							{ header: 'HEALTH', key: 'health', width: 12 },
						],
						sources.map((s) => ({
							name: String(s.id ?? s.name ?? ''),
							type: String(s.type ?? 'poll'),
							health: s.health ? healthStatusColor(String(s.health)) : chalk.dim('—'),
						})),
					);
				}

				// Route count
				const routes = (data.routes ?? []) as Array<unknown>;
				output.blank();
				output.info(`  Routes: ${routes.length}`);
				output.blank();
			} catch (err) {
				output.error(`Module status failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});

	// ── module load <path> ──────────────────────────────────────────────────
	mod
		.command('load <path>')
		.description('Load a module into the running runtime')
		.option('--params <json>', 'Module parameters as JSON string')
		.option('--params-file <path>', 'Path to JSON file with module parameters')
		.action(async (modulePath: string, opts: { params?: string; paramsFile?: string }) => {
			try {
				let params: Record<string, unknown> = {};

				if (opts.paramsFile) {
					try {
						const content = await readFile(opts.paramsFile, 'utf-8');
						params = JSON.parse(content) as Record<string, unknown>;
					} catch (err) {
						output.error(
							`Failed to read params file: ${err instanceof Error ? err.message : String(err)}`,
						);
						process.exitCode = 1;
						return;
					}
				}

				if (opts.params) {
					try {
						params = JSON.parse(opts.params) as Record<string, unknown>;
					} catch {
						output.error('Invalid JSON in --params');
						process.exitCode = 1;
						return;
					}
				}

				const baseUrl = await getControlUrl();
				const spin = output.spinner(`Loading module ${modulePath}...`);

				const { status, data } = await controlRequest('POST', `${baseUrl}/module/load`, {
					package: modulePath,
					params,
				});

				spin.stop();

				if (status !== 200) {
					output.error(
						`Failed to load module: ${(data as Record<string, unknown>).error ?? `HTTP ${status}`}`,
					);
					process.exitCode = 1;
					return;
				}

				if (output.isJsonMode()) {
					output.json(data);
					return;
				}

				output.success(`Module ${data.name ?? modulePath} loaded.`);
			} catch (err) {
				output.error(`Module load failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});

	// ── module unload <name> ────────────────────────────────────────────────
	mod
		.command('unload <name>')
		.description('Unload a module from the running runtime')
		.action(async (name: string) => {
			try {
				const baseUrl = await getControlUrl();
				const spin = output.spinner(`Unloading module ${name}...`);

				const { status, data } = await controlRequest('POST', `${baseUrl}/module/unload`, { name });

				spin.stop();

				if (status !== 200) {
					output.error(
						`Failed to unload module: ${(data as Record<string, unknown>).error ?? `HTTP ${status}`}`,
					);
					process.exitCode = 1;
					return;
				}

				if (output.isJsonMode()) {
					output.json(data);
					return;
				}

				output.success(`Module ${name} unloaded.`);
			} catch (err) {
				output.error(`Module unload failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});

	// ── module reload <name> ────────────────────────────────────────────────
	mod
		.command('reload <name>')
		.description('Reload a module in the running runtime')
		.action(async (name: string) => {
			try {
				const baseUrl = await getControlUrl();
				const spin = output.spinner(`Reloading module ${name}...`);

				const { status, data } = await controlRequest('POST', `${baseUrl}/module/reload`, { name });

				spin.stop();

				if (status !== 200) {
					output.error(
						`Failed to reload module: ${(data as Record<string, unknown>).error ?? `HTTP ${status}`}`,
					);
					process.exitCode = 1;
					return;
				}

				if (output.isJsonMode()) {
					output.json(data);
					return;
				}

				output.success(`Module ${name} reloaded.`);
			} catch (err) {
				output.error(`Module reload failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});
}
