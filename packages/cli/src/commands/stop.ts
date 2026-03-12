/**
 * orgloop stop — Stop the current module or the entire daemon.
 *
 * Module-aware behavior:
 * - In a project dir → unregister just this dir's module
 * - If no other modules remain → also shut down the daemon
 * - If other modules still running → daemon stays alive
 *
 * Use `orgloop shutdown` to unconditionally stop the daemon and all modules.
 */

import { readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { resolveConfigPath } from '../config.js';
import {
	isProcessRunning,
	shutdownDaemon,
	unloadModuleFromDaemon,
	waitForPortRelease,
} from '../daemon-client.js';
import {
	clearModulesState,
	findModuleByDir,
	readModulesState,
	unregisterModule,
} from '../module-registry.js';
import * as output from '../output.js';

const PID_DIR = join(homedir(), '.orgloop');
const PID_FILE = join(PID_DIR, 'orgloop.pid');
const PORT_FILE = join(PID_DIR, 'runtime.port');
const SHUTDOWN_TIMEOUT_MS = 10_000;

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

async function fullShutdown(pid: number, port: number | null, force: boolean): Promise<void> {
	output.info(`Stopping OrgLoop daemon (PID ${pid})...`);

	if (force) {
		process.kill(pid, 'SIGKILL');
		output.success('Force killed.');
		if (port) {
			const released = await waitForPortRelease(port, 5_000);
			if (!released) {
				output.warn(`Port ${port} still in use after force kill. It may take a moment to release.`);
			}
		}
		await cleanupFiles();
		await clearModulesState();
		return;
	}

	// Try graceful shutdown via control API first
	let apiShutdown = false;
	if (port) {
		output.info('Requesting graceful shutdown via control API...');
		apiShutdown = await shutdownDaemon(port);
	}

	if (!apiShutdown) {
		process.kill(pid, 'SIGTERM');
		output.info('Sent SIGTERM, waiting for shutdown...');
	}

	const exited = await waitForExit(pid, SHUTDOWN_TIMEOUT_MS);
	if (exited) {
		output.success('Stopped.');
	} else {
		output.warn(`Process did not exit within ${SHUTDOWN_TIMEOUT_MS / 1000}s. Sending SIGKILL...`);
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			/* already dead */
		}
		output.success('Force killed.');
	}

	// Wait for port to be released to prevent EADDRINUSE on restart (issue #95)
	if (port) {
		const released = await waitForPortRelease(port, 5_000);
		if (!released) {
			output.warn(
				`Port ${port} still in use. Subsequent start may fail until the port is released.`,
			);
		}
	}

	await cleanupFiles();
	await clearModulesState();
}

export function registerStopCommand(program: Command): void {
	program
		.command('stop')
		.description('Stop the current module (or the daemon if it is the last module)')
		.option('--force', 'Force kill with SIGKILL')
		.option('--all', 'Stop the daemon and all modules (alias for `orgloop shutdown`)')
		.action(async (opts, cmd) => {
			try {
				const globalOpts = cmd.parent?.opts() ?? {};

				// Read PID file
				let pid: number;
				try {
					const pidStr = await readFile(PID_FILE, 'utf-8');
					pid = Number.parseInt(pidStr.trim(), 10);
					if (Number.isNaN(pid)) {
						output.error(`Invalid PID in ${PID_FILE}`);
						process.exitCode = 1;
						return;
					}
				} catch {
					output.info('OrgLoop is not running (no PID file found).');
					return;
				}

				if (!isProcessRunning(pid)) {
					output.info('OrgLoop is not running (stale PID file).');
					await cleanupFiles();
					await clearModulesState();
					return;
				}

				// Read port for control API
				let port: number | null = null;
				try {
					const portStr = await readFile(PORT_FILE, 'utf-8');
					port = Number.parseInt(portStr.trim(), 10);
					if (Number.isNaN(port)) port = null;
				} catch {
					// No port file
				}

				// If --all flag, do full shutdown
				if (opts.all) {
					await fullShutdown(pid, port, opts.force);
					if (output.isJsonMode()) {
						output.json({ stopped: true, pid, all: true });
					}
					return;
				}

				// Module-aware stop: determine which module this directory owns
				const configPath = resolveConfigPath(globalOpts.config as string | undefined);
				const projectDir = resolve(dirname(configPath));
				const registeredModule = await findModuleByDir(projectDir);

				if (!registeredModule) {
					// No registered module for this directory — fall back to full shutdown
					output.warn('No module registered for this directory. Stopping the daemon.');
					await fullShutdown(pid, port, opts.force);
					if (output.isJsonMode()) {
						output.json({ stopped: true, pid, all: true });
					}
					return;
				}

				// Check how many modules are registered
				const state = await readModulesState();
				const moduleCount = state.modules.length;

				if (moduleCount <= 1) {
					// Last module — shut down the daemon entirely
					output.info(
						`Module "${registeredModule.name}" is the last module. Shutting down daemon.`,
					);
					await fullShutdown(pid, port, opts.force);
					if (output.isJsonMode()) {
						output.json({
							stopped: true,
							pid,
							module: registeredModule.name,
							daemonStopped: true,
						});
					}
					return;
				}

				// Multiple modules — unload just this one
				if (port) {
					try {
						output.info(`Unloading module "${registeredModule.name}"...`);
						await unloadModuleFromDaemon(port, registeredModule.name);
						await unregisterModule(registeredModule.name);
						output.success(
							`Module "${registeredModule.name}" stopped. Daemon continues with ${moduleCount - 1} module(s).`,
						);

						if (output.isJsonMode()) {
							output.json({
								stopped: true,
								module: registeredModule.name,
								daemonStopped: false,
								remainingModules: moduleCount - 1,
							});
						}
					} catch (err) {
						output.error(
							`Failed to unload module: ${err instanceof Error ? err.message : String(err)}`,
						);
						process.exitCode = 1;
					}
				} else {
					// No control API available — fall back to full shutdown
					output.warn('Control API not available. Stopping the daemon.');
					await fullShutdown(pid, port, opts.force);
				}
			} catch (err) {
				const errObj = err as NodeJS.ErrnoException;
				if (errObj.code === 'EPERM' || errObj.code === 'EACCES') {
					output.error(
						'Permission denied. The daemon may have been started by another user. Try: sudo orgloop stop',
					);
				} else {
					output.error(`Stop failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				process.exitCode = 1;
			}
		});
}
