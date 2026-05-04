/**
 * Crash handler installation and heartbeat helpers for Runtime.
 *
 * Extracted to keep runtime.ts focused on lifecycle + dispatch.
 */

import { mkdir, writeFile } from 'node:fs/promises';

export interface CrashHandlerHooks {
	onError: (err: Error) => void;
	onLog: (message: string) => Promise<void>;
	stop: () => Promise<void>;
}

export interface CrashHandlerHandle {
	uninstall(): void;
}

export function installCrashHandlers(hooks: CrashHandlerHooks): CrashHandlerHandle {
	const buildHandler = (label: string) => (reasonOrErr: unknown) => {
		const err =
			reasonOrErr instanceof Error ? reasonOrErr : new Error(`${label}: ${String(reasonOrErr)}`);
		const message = `${label}: ${err.message}`;
		console.error(`[orgloop] ${message}`);
		if (err.stack) console.error(err.stack);
		hooks.onError(err);
		void hooks.onLog(message).catch(() => {});
		const forceExit = setTimeout(() => process.exit(1), 5_000);
		if (forceExit.unref) forceExit.unref();
		void hooks
			.stop()
			.catch(() => {})
			.finally(() => {
				clearTimeout(forceExit);
				process.exit(1);
			});
	};

	const onUncaught = buildHandler('Uncaught exception');
	const onRejection = buildHandler('Unhandled rejection');

	process.on('uncaughtException', onUncaught);
	process.on('unhandledRejection', onRejection);

	return {
		uninstall() {
			process.removeListener('uncaughtException', onUncaught);
			process.removeListener('unhandledRejection', onRejection);
		},
	};
}

export interface HeartbeatOptions {
	dir: string;
	file: string;
	intervalMs: number;
	snapshot: () => { pid: number; uptime_ms: number; modules: number };
}

export interface HeartbeatHandle {
	stop(): void;
}

export function startHeartbeat(opts: HeartbeatOptions): HeartbeatHandle {
	const writeOnce = async (): Promise<void> => {
		try {
			await mkdir(opts.dir, { recursive: true });
			const snap = opts.snapshot();
			const data = JSON.stringify({ ...snap, timestamp: new Date().toISOString() });
			await writeFile(opts.file, data, 'utf-8');
		} catch {
			// Heartbeat is best-effort.
		}
	};
	void writeOnce();
	const timer = setInterval(() => void writeOnce(), opts.intervalMs);
	if (timer.unref) timer.unref();
	return {
		stop() {
			clearInterval(timer);
		},
	};
}
