/**
 * Daemon client — communicates with a running OrgLoop daemon via its control API.
 *
 * Reads ~/.orgloop/runtime.port to discover the daemon's HTTP port,
 * then makes requests to the control API endpoints.
 */

import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModuleStatus, RuntimeStatus } from '@orgloop/sdk';

const PID_DIR = join(homedir(), '.orgloop');
const PID_FILE = join(PID_DIR, 'orgloop.pid');
const PORT_FILE = join(PID_DIR, 'runtime.port');

export interface DaemonInfo {
	pid: number;
	port: number;
}

/** Check if a process is running by PID. */
export function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Read daemon PID and port from state files. Returns null if no daemon is running. */
export async function getDaemonInfo(): Promise<DaemonInfo | null> {
	try {
		const pidStr = await readFile(PID_FILE, 'utf-8');
		const pid = Number.parseInt(pidStr.trim(), 10);
		if (Number.isNaN(pid) || !isProcessRunning(pid)) return null;

		const portStr = await readFile(PORT_FILE, 'utf-8');
		const port = Number.parseInt(portStr.trim(), 10);
		if (Number.isNaN(port)) return null;

		return { pid, port };
	} catch {
		return null;
	}
}

/** Get full runtime status from a running daemon. */
export async function getDaemonStatus(port: number): Promise<RuntimeStatus | null> {
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

/** List modules registered in a running daemon. */
export async function listDaemonModules(port: number): Promise<ModuleStatus[]> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/control/module/list`, {
			signal: AbortSignal.timeout(3_000),
		});
		if (res.ok) {
			return (await res.json()) as ModuleStatus[];
		}
	} catch {
		// Control API not reachable
	}
	return [];
}

/** Load a module into a running daemon via control API. */
export async function loadModuleIntoDaemon(
	port: number,
	moduleConfig: Record<string, unknown>,
): Promise<ModuleStatus> {
	const res = await fetch(`http://127.0.0.1:${port}/control/module/load`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(moduleConfig),
		signal: AbortSignal.timeout(10_000),
	});

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `HTTP ${res.status}`);
	}

	return (await res.json()) as ModuleStatus;
}

/** Unload a module from a running daemon via control API. */
export async function unloadModuleFromDaemon(port: number, moduleName: string): Promise<void> {
	const res = await fetch(`http://127.0.0.1:${port}/control/module/unload`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: moduleName }),
		signal: AbortSignal.timeout(10_000),
	});

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `HTTP ${res.status}`);
	}
}

/** Reload a module in a running daemon via control API. */
export async function reloadModuleInDaemon(port: number, moduleName: string): Promise<void> {
	const res = await fetch(`http://127.0.0.1:${port}/control/module/reload`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: moduleName }),
		signal: AbortSignal.timeout(10_000),
	});

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `HTTP ${res.status}`);
	}
}

/** Shut down the entire daemon via control API. */
export async function shutdownDaemon(port: number): Promise<boolean> {
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

/** Check if a TCP port is in use by attempting to connect. */
export function isPortInUse(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ port, host: '127.0.0.1' });
		socket.once('connect', () => {
			socket.destroy();
			resolve(true);
		});
		socket.once('error', () => {
			resolve(false);
		});
	});
}

/** Wait for a port to be released, polling until timeout. */
export async function waitForPortRelease(port: number, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (!(await isPortInUse(port))) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

/** Probe the control port to check if a daemon is actually responding. */
export async function probeControlPort(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/control/status`, {
			signal: AbortSignal.timeout(2_000),
		});
		return res.ok;
	} catch {
		return false;
	}
}
