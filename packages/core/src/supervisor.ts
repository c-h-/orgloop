/**
 * Supervisor — restarts the daemon child process on abnormal exit.
 *
 * Exponential backoff with crash loop detection. Forwards signals
 * to the child and cleans up on shutdown.
 */

import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SUPERVISOR_DIR = join(homedir(), '.orgloop');
const SUPERVISOR_PID_FILE = join(SUPERVISOR_DIR, 'supervisor.pid');

export interface SupervisorOptions {
	/** Path to the module to fork (the start.ts file) */
	modulePath: string;
	/** Environment variables for the child */
	env?: Record<string, string>;
	/** Log file descriptors: [stdout fd, stderr fd] */
	stdio?: [number, number];
	/** Max restarts within the crash window before giving up (default: 10) */
	maxRestarts?: number;
	/** Crash window in ms — resets restart count after stable running (default: 300_000 = 5m) */
	crashWindowMs?: number;
	/** Initial backoff delay in ms (default: 1000) */
	initialBackoffMs?: number;
	/** Maximum backoff delay in ms (default: 30_000) */
	maxBackoffMs?: number;
	/** Stable running threshold — reset backoff after this many ms of uptime (default: 60_000) */
	stableThresholdMs?: number;
}

export interface SupervisorStatus {
	running: boolean;
	childPid: number | null;
	restartCount: number;
	lastExitCode: number | null;
	lastExitSignal: string | null;
	crashLoopDetected: boolean;
}

export class Supervisor {
	private child: ChildProcess | null = null;
	private running = false;
	private shuttingDown = false;
	private restartCount = 0;
	private windowRestartCount = 0;
	private windowStartTime = 0;
	private lastChildStart = 0;
	private currentBackoffMs: number;
	private restartTimer: ReturnType<typeof setTimeout> | null = null;
	private lastExitCode: number | null = null;
	private lastExitSignal: string | null = null;
	private crashLoopDetected = false;

	private readonly modulePath: string;
	private readonly env: Record<string, string>;
	private readonly stdioFds: [number, number] | null;
	private readonly maxRestarts: number;
	private readonly crashWindowMs: number;
	private readonly initialBackoffMs: number;
	private readonly maxBackoffMs: number;
	private readonly stableThresholdMs: number;

	/** Callback for logging — set by consumer */
	onLog: ((message: string) => void) | null = null;
	/** Callback when crash loop detected */
	onCrashLoop: (() => void) | null = null;

	constructor(options: SupervisorOptions) {
		this.modulePath = options.modulePath;
		this.env = options.env ?? {};
		this.stdioFds = options.stdio ?? null;
		this.maxRestarts = options.maxRestarts ?? 10;
		this.crashWindowMs = options.crashWindowMs ?? 300_000;
		this.initialBackoffMs = options.initialBackoffMs ?? 1_000;
		this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
		this.stableThresholdMs = options.stableThresholdMs ?? 60_000;
		this.currentBackoffMs = this.initialBackoffMs;
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.shuttingDown = false;
		this.crashLoopDetected = false;
		this.restartCount = 0;
		this.windowRestartCount = 0;
		this.windowStartTime = Date.now();
		this.currentBackoffMs = this.initialBackoffMs;

		// Write supervisor PID
		await mkdir(SUPERVISOR_DIR, { recursive: true });
		await writeFile(SUPERVISOR_PID_FILE, String(process.pid), 'utf-8');

		this.spawnChild();
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		this.shuttingDown = true;
		this.running = false;

		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}

		if (this.child && this.child.exitCode === null) {
			// Send SIGTERM to child
			this.child.kill('SIGTERM');

			// Wait up to 5s for graceful exit
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(() => {
					if (this.child && this.child.exitCode === null) {
						this.child.kill('SIGKILL');
					}
					resolve();
				}, 5_000);

				if (this.child) {
					this.child.once('exit', () => {
						clearTimeout(timeout);
						resolve();
					});
				} else {
					clearTimeout(timeout);
					resolve();
				}
			});
		}

		// Clean up supervisor PID file
		try {
			await unlink(SUPERVISOR_PID_FILE);
		} catch {
			/* ignore */
		}
	}

	status(): SupervisorStatus {
		return {
			running: this.running,
			childPid: this.child?.pid ?? null,
			restartCount: this.restartCount,
			lastExitCode: this.lastExitCode,
			lastExitSignal: this.lastExitSignal,
			crashLoopDetected: this.crashLoopDetected,
		};
	}

	private spawnChild(): void {
		const stdio = this.stdioFds
			? ['ignore' as const, this.stdioFds[0], this.stdioFds[1], 'ipc' as const]
			: ['ignore' as const, 'inherit' as const, 'inherit' as const, 'ipc' as const];

		this.child = fork(this.modulePath, [], {
			detached: false,
			stdio,
			env: {
				...process.env,
				...this.env,
				ORGLOOP_DAEMON: '1',
				ORGLOOP_SUPERVISED: '1',
			},
		});

		this.lastChildStart = Date.now();

		this.child.on('exit', (code, signal) => {
			this.lastExitCode = code;
			this.lastExitSignal = signal;
			this.handleChildExit(code, signal);
		});

		this.child.on('error', (err) => {
			this.log(`Child process error: ${err.message}`);
		});

		// Disconnect IPC so child can run independently
		if (this.child.connected) {
			this.child.disconnect();
		}
	}

	private handleChildExit(code: number | null, signal: string | null): void {
		if (this.shuttingDown) {
			this.log('Child exited during shutdown');
			return;
		}

		if (code === 0) {
			this.log('Child exited cleanly (code 0)');
			this.running = false;
			return;
		}

		// Abnormal exit — consider restart
		this.log(`Child exited abnormally (code=${code}, signal=${signal})`);

		// Check if child ran long enough to be considered stable
		const uptime = Date.now() - this.lastChildStart;
		if (uptime >= this.stableThresholdMs) {
			// Reset backoff — child was stable before crashing
			this.currentBackoffMs = this.initialBackoffMs;
			this.windowRestartCount = 0;
			this.windowStartTime = Date.now();
		}

		// Check crash window
		if (Date.now() - this.windowStartTime > this.crashWindowMs) {
			// Window expired, reset counter
			this.windowRestartCount = 0;
			this.windowStartTime = Date.now();
		}

		this.windowRestartCount++;
		this.restartCount++;

		if (this.windowRestartCount >= this.maxRestarts) {
			this.crashLoopDetected = true;
			this.running = false;
			this.log(
				`Crash loop detected: ${this.windowRestartCount} restarts in ${Math.round(this.crashWindowMs / 1000)}s window. Giving up.`,
			);
			this.onCrashLoop?.();
			return;
		}

		// Schedule restart with backoff
		this.log(`Restarting in ${this.currentBackoffMs}ms (attempt ${this.restartCount})`);

		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			if (this.running && !this.shuttingDown) {
				this.spawnChild();
			}
		}, this.currentBackoffMs);

		// Exponential backoff
		this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.maxBackoffMs);
	}

	private log(message: string): void {
		this.onLog?.(`[supervisor] ${message}`);
	}
}
