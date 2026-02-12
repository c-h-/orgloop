/**
 * orgloop stop — Stop the running runtime.
 *
 * Tries graceful shutdown via control API first (POST /control/shutdown),
 * falls back to SIGTERM via PID file.
 */

import { readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import * as output from '../output.js';

const PID_DIR = join(homedir(), '.orgloop');
const PID_FILE = join(PID_DIR, 'orgloop.pid');
const PORT_FILE = join(PID_DIR, 'runtime.port');
const SHUTDOWN_TIMEOUT_MS = 10_000;

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (!isProcessRunning(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return false;
}

async function cleanupFiles(): Promise<void> {
	for (const file of [PID_FILE, PORT_FILE]) {
		try {
			await unlink(file);
		} catch {
			/* ignore */
		}
	}
}

async function tryControlApiShutdown(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/control/shutdown`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			signal: AbortSignal.timeout(5_000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

export function registerStopCommand(program: Command): void {
	program
		.command('stop')
		.description('Stop the running runtime')
		.option('--force', 'Force kill with SIGKILL')
		.action(async (opts) => {
			try {
				let pidStr: string;
				try {
					pidStr = await readFile(PID_FILE, 'utf-8');
				} catch {
					output.info('OrgLoop is not running (no PID file found).');
					return;
				}

				const pid = Number.parseInt(pidStr.trim(), 10);
				if (Number.isNaN(pid)) {
					output.error(`Invalid PID in ${PID_FILE}`);
					process.exitCode = 1;
					return;
				}

				if (!isProcessRunning(pid)) {
					output.info('OrgLoop is not running (stale PID file).');
					await cleanupFiles();
					return;
				}

				output.info(`Stopping OrgLoop (PID ${pid})...`);

				if (opts.force) {
					process.kill(pid, 'SIGKILL');
					output.success('Force killed.');
					await cleanupFiles();
				} else {
					// Try graceful shutdown via control API first
					let apiShutdown = false;
					try {
						const portStr = await readFile(PORT_FILE, 'utf-8');
						const port = Number.parseInt(portStr.trim(), 10);
						if (!Number.isNaN(port)) {
							output.info('Requesting graceful shutdown via control API...');
							apiShutdown = await tryControlApiShutdown(port);
						}
					} catch {
						// No port file — fall through to SIGTERM
					}

					if (!apiShutdown) {
						// Fallback to SIGTERM
						process.kill(pid, 'SIGTERM');
						output.info('Sent SIGTERM, waiting for shutdown...');
					}

					const exited = await waitForExit(pid, SHUTDOWN_TIMEOUT_MS);
					if (exited) {
						output.success('Stopped.');
					} else {
						output.warn(
							`Process did not exit within ${SHUTDOWN_TIMEOUT_MS / 1000}s. Sending SIGKILL...`,
						);
						try {
							process.kill(pid, 'SIGKILL');
						} catch {
							/* already dead */
						}
						output.success('Force killed.');
					}

					await cleanupFiles();
				}

				if (output.isJsonMode()) {
					output.json({ stopped: true, pid });
				}
			} catch (err) {
				output.error(`Stop failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});
}
