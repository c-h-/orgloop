import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Supervisor } from '../supervisor.js';

const SUPERVISOR_PID_FILE = join(homedir(), '.orgloop', 'supervisor.pid');

describe('Supervisor', () => {
	let supervisor: Supervisor;

	afterEach(async () => {
		if (supervisor) {
			await supervisor.stop();
		}
		try {
			await unlink(SUPERVISOR_PID_FILE);
		} catch {
			/* ignore */
		}
	});

	it('initializes with default options', () => {
		supervisor = new Supervisor({ modulePath: '/dev/null' });
		const status = supervisor.status();
		expect(status.running).toBe(false);
		expect(status.childPid).toBeNull();
		expect(status.restartCount).toBe(0);
		expect(status.crashLoopDetected).toBe(false);
	});

	it('accepts custom options', () => {
		supervisor = new Supervisor({
			modulePath: '/dev/null',
			maxRestarts: 5,
			crashWindowMs: 60_000,
			initialBackoffMs: 500,
			maxBackoffMs: 10_000,
			stableThresholdMs: 30_000,
		});
		expect(supervisor).toBeDefined();
	});

	it('reports status correctly when not started', () => {
		supervisor = new Supervisor({ modulePath: '/dev/null' });
		const status = supervisor.status();
		expect(status).toEqual({
			running: false,
			childPid: null,
			restartCount: 0,
			lastExitCode: null,
			lastExitSignal: null,
			crashLoopDetected: false,
		});
	});

	it('stop is safe to call when not started', async () => {
		supervisor = new Supervisor({ modulePath: '/dev/null' });
		await expect(supervisor.stop()).resolves.not.toThrow();
	});

	it('start is idempotent', async () => {
		// Use a script that exits immediately to avoid blocking
		const scriptPath = join(homedir(), '.orgloop', 'test-supervisor-noop.mjs');
		await mkdir(join(homedir(), '.orgloop'), { recursive: true });
		await writeFile(scriptPath, 'process.exit(0);', 'utf-8');

		supervisor = new Supervisor({
			modulePath: scriptPath,
			env: {},
		});

		await supervisor.start();
		// Second start should be no-op
		await supervisor.start();

		expect(supervisor.status().running).toBe(true);

		await supervisor.stop();

		try {
			await unlink(scriptPath);
		} catch {
			/* ignore */
		}
	});

	it('writes supervisor PID file on start', async () => {
		const scriptPath = join(homedir(), '.orgloop', 'test-supervisor-pid.mjs');
		await mkdir(join(homedir(), '.orgloop'), { recursive: true });
		await writeFile(scriptPath, 'setTimeout(() => {}, 60000);', 'utf-8');

		supervisor = new Supervisor({
			modulePath: scriptPath,
			env: {},
		});

		await supervisor.start();

		const pidContent = await readFile(SUPERVISOR_PID_FILE, 'utf-8');
		expect(Number.parseInt(pidContent, 10)).toBe(process.pid);

		await supervisor.stop();

		try {
			await unlink(scriptPath);
		} catch {
			/* ignore */
		}
	});

	it('detects crash loop after max restarts', async () => {
		const scriptPath = join(homedir(), '.orgloop', 'test-supervisor-crash.mjs');
		await mkdir(join(homedir(), '.orgloop'), { recursive: true });
		await writeFile(scriptPath, 'process.exit(1);', 'utf-8');

		const logs: string[] = [];
		let crashLoopCalled = false;

		supervisor = new Supervisor({
			modulePath: scriptPath,
			env: {},
			maxRestarts: 3,
			crashWindowMs: 60_000,
			initialBackoffMs: 10,
			maxBackoffMs: 50,
			stableThresholdMs: 1_000,
		});

		supervisor.onLog = (msg) => logs.push(msg);
		supervisor.onCrashLoop = () => {
			crashLoopCalled = true;
		};

		await supervisor.start();

		// Wait for crash loop detection (3 restarts × ~50ms backoff + exit time)
		await new Promise((resolve) => setTimeout(resolve, 2_000));

		expect(crashLoopCalled).toBe(true);
		expect(supervisor.status().crashLoopDetected).toBe(true);
		expect(supervisor.status().restartCount).toBeGreaterThanOrEqual(3);

		try {
			await unlink(scriptPath);
		} catch {
			/* ignore */
		}
	});

	it('tracks exit codes and signals', async () => {
		const scriptPath = join(homedir(), '.orgloop', 'test-supervisor-exit.mjs');
		await mkdir(join(homedir(), '.orgloop'), { recursive: true });
		await writeFile(scriptPath, 'process.exit(42);', 'utf-8');

		supervisor = new Supervisor({
			modulePath: scriptPath,
			env: {},
			maxRestarts: 1,
			initialBackoffMs: 10,
			maxBackoffMs: 50,
			crashWindowMs: 60_000,
		});

		await supervisor.start();

		// Wait for exit
		await new Promise((resolve) => setTimeout(resolve, 500));

		const status = supervisor.status();
		expect(status.lastExitCode).toBe(42);

		try {
			await unlink(scriptPath);
		} catch {
			/* ignore */
		}
	});

	it('stops cleanly after child exits', async () => {
		const scriptPath = join(homedir(), '.orgloop', 'test-supervisor-clean.mjs');
		await mkdir(join(homedir(), '.orgloop'), { recursive: true });
		await writeFile(scriptPath, 'process.exit(0);', 'utf-8');

		supervisor = new Supervisor({
			modulePath: scriptPath,
			env: {},
		});

		await supervisor.start();

		// Wait for child to exit cleanly
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Clean exit (code 0) should stop the supervisor
		expect(supervisor.status().running).toBe(false);
		expect(supervisor.status().lastExitCode).toBe(0);

		try {
			await unlink(scriptPath);
		} catch {
			/* ignore */
		}
	});
});
