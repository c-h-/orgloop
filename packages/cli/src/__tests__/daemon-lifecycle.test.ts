/**
 * Daemon lifecycle tests — PID file management, stale detection,
 * duplicate prevention, signal handling, and graceful shutdown.
 *
 * These tests exercise the same patterns used in apply.ts and stop.ts
 * without relying on full OrgLoop engine startup.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let testDir: string;
let pidFile: string;

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function cleanupPidFile(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch {
		/* ignore */
	}
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (!isProcessRunning(pid)) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return false;
}

beforeEach(async () => {
	testDir = join(
		tmpdir(),
		`orgloop-daemon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(testDir, { recursive: true });
	pidFile = join(testDir, 'orgloop.pid');
});

afterEach(async () => {
	await rm(testDir, { recursive: true, force: true });
});

// ─── PID file creation and reading ───────────────────────────────────────────

describe('PID file management', () => {
	it('creates a PID file with the process ID', async () => {
		const pid = process.pid;
		await writeFile(pidFile, String(pid), 'utf-8');

		const content = await readFile(pidFile, 'utf-8');
		expect(Number.parseInt(content.trim(), 10)).toBe(pid);
	});

	it('removes PID file on cleanup', async () => {
		await writeFile(pidFile, String(process.pid), 'utf-8');
		await cleanupPidFile(pidFile);

		await expect(readFile(pidFile, 'utf-8')).rejects.toThrow();
	});

	it('cleanup is idempotent (no error on missing file)', async () => {
		// Should not throw even if file doesn't exist
		await expect(cleanupPidFile(pidFile)).resolves.toBeUndefined();
	});
});

// ─── Process detection ───────────────────────────────────────────────────────

describe('isProcessRunning', () => {
	it('returns true for the current process', () => {
		expect(isProcessRunning(process.pid)).toBe(true);
	});

	it('returns false for a non-existent PID', () => {
		// PID 99999999 is unlikely to exist
		expect(isProcessRunning(99999999)).toBe(false);
	});

	it('returns false for PID 0 (kernel)', () => {
		// PID 0 is special and kill(0, 0) sends to process group, not PID 0
		// On macOS/Linux, this should not match a real daemon check
		// We test that it doesn't crash
		const result = isProcessRunning(0);
		expect(typeof result).toBe('boolean');
	});
});

// ─── Stale PID file detection ────────────────────────────────────────────────

describe('stale PID file detection', () => {
	it('detects a stale PID file (process no longer running)', async () => {
		// Write a PID that definitely doesn't exist
		await writeFile(pidFile, '99999999', 'utf-8');

		const pidStr = await readFile(pidFile, 'utf-8');
		const pid = Number.parseInt(pidStr.trim(), 10);

		expect(Number.isNaN(pid)).toBe(false);
		expect(isProcessRunning(pid)).toBe(false);

		// Clean up stale PID file (mirrors apply.ts behavior)
		await cleanupPidFile(pidFile);
		await expect(readFile(pidFile, 'utf-8')).rejects.toThrow();
	});

	it('detects a running process via PID file', async () => {
		await writeFile(pidFile, String(process.pid), 'utf-8');

		const pidStr = await readFile(pidFile, 'utf-8');
		const pid = Number.parseInt(pidStr.trim(), 10);

		expect(isProcessRunning(pid)).toBe(true);
	});

	it('handles invalid PID content in file', async () => {
		await writeFile(pidFile, 'not-a-number', 'utf-8');

		const pidStr = await readFile(pidFile, 'utf-8');
		const pid = Number.parseInt(pidStr.trim(), 10);

		expect(Number.isNaN(pid)).toBe(true);
	});
});

// ─── Duplicate instance prevention ───────────────────────────────────────────

describe('duplicate instance prevention', () => {
	it('blocks second start when first is running', async () => {
		// Simulate first instance writing PID file
		await writeFile(pidFile, String(process.pid), 'utf-8');

		// Second instance checks for existing PID
		const pidStr = await readFile(pidFile, 'utf-8');
		const existingPid = Number.parseInt(pidStr.trim(), 10);

		const shouldBlock = !Number.isNaN(existingPid) && isProcessRunning(existingPid);
		expect(shouldBlock).toBe(true);
	});

	it('allows start when PID file exists but process is dead', async () => {
		// Simulate stale PID file
		await writeFile(pidFile, '99999999', 'utf-8');

		const pidStr = await readFile(pidFile, 'utf-8');
		const existingPid = Number.parseInt(pidStr.trim(), 10);

		const shouldBlock = !Number.isNaN(existingPid) && isProcessRunning(existingPid);
		expect(shouldBlock).toBe(false);

		// Clean up stale file and proceed
		await cleanupPidFile(pidFile);
	});

	it('allows start when no PID file exists', async () => {
		let shouldBlock = false;
		try {
			await readFile(pidFile, 'utf-8');
			shouldBlock = true; // shouldn't reach here
		} catch {
			// No PID file — proceed
			shouldBlock = false;
		}

		expect(shouldBlock).toBe(false);
	});
});

// ─── Signal handling with real child process ─────────────────────────────────

describe('signal handling', () => {
	let child: ChildProcess;

	afterEach(async () => {
		// Ensure child is cleaned up
		if (child?.pid && isProcessRunning(child.pid)) {
			try {
				process.kill(child.pid, 'SIGKILL');
			} catch {
				/* already dead */
			}
			await waitForExit(child.pid, 3000);
		}
	});

	it('SIGTERM causes graceful shutdown of a child process', async () => {
		// Spawn a simple long-running process
		child = spawn(
			'node',
			['-e', 'process.on("SIGTERM", () => process.exit(0)); setTimeout(() => {}, 60000)'],
			{
				stdio: 'ignore',
			},
		);

		expect(child.pid).toBeDefined();
		const pid = child.pid as number;

		// Give it a moment to start
		await new Promise((r) => setTimeout(r, 100));
		expect(isProcessRunning(pid)).toBe(true);

		// Write its PID file
		await writeFile(pidFile, String(pid), 'utf-8');

		// Send SIGTERM (mirrors stop.ts behavior)
		process.kill(pid, 'SIGTERM');

		// Wait for exit
		const exited = await waitForExit(pid, 5000);
		expect(exited).toBe(true);

		// Clean up PID file
		await cleanupPidFile(pidFile);
	});

	it('process exit cleans up naturally', async () => {
		// Spawn a process that exits immediately
		child = spawn('node', ['-e', 'process.exit(0)'], {
			stdio: 'ignore',
		});

		const pid = child.pid as number;

		// Wait for natural exit
		const exited = await waitForExit(pid, 3000);
		expect(exited).toBe(true);
		expect(isProcessRunning(pid)).toBe(false);
	});
});

// ─── Daemon log directory ────────────────────────────────────────────────────

describe('daemon log directory', () => {
	it('creates log directory structure', async () => {
		const logDir = join(testDir, 'logs');
		await mkdir(logDir, { recursive: true });

		const stdoutLog = join(logDir, 'daemon.stdout.log');
		const stderrLog = join(logDir, 'daemon.stderr.log');

		await writeFile(stdoutLog, 'test stdout\n', 'utf-8');
		await writeFile(stderrLog, 'test stderr\n', 'utf-8');

		const stdout = await readFile(stdoutLog, 'utf-8');
		const stderr = await readFile(stderrLog, 'utf-8');

		expect(stdout).toContain('test stdout');
		expect(stderr).toContain('test stderr');
	});
});

// ─── waitForExit ─────────────────────────────────────────────────────────────

describe('waitForExit', () => {
	it('returns true immediately for a dead process', async () => {
		const start = Date.now();
		const result = await waitForExit(99999999, 5000);
		const elapsed = Date.now() - start;

		expect(result).toBe(true);
		expect(elapsed).toBeLessThan(200); // Should return quickly
	});

	it('returns false after timeout for a running process', async () => {
		const start = Date.now();
		const result = await waitForExit(process.pid, 300);
		const elapsed = Date.now() - start;

		expect(result).toBe(false);
		expect(elapsed).toBeGreaterThanOrEqual(250); // Should wait near timeout
	});
});

// ─── SIGTERM + PID file cleanup (integration) ────────────────────────────────

describe('SIGTERM triggers PID file cleanup', () => {
	let child: ChildProcess;

	afterEach(async () => {
		if (child?.pid && isProcessRunning(child.pid)) {
			try {
				process.kill(child.pid, 'SIGKILL');
			} catch {
				/* already dead */
			}
			await waitForExit(child.pid, 3000);
		}
	});

	it('child process removes its own PID file on SIGTERM', async () => {
		// Spawn a process that writes a PID file and cleans it up on SIGTERM
		// This mirrors the apply.ts shutdown handler behavior
		const script = [
			"const fs = require('fs');",
			'const pidFile = process.argv[1];',
			"fs.writeFileSync(pidFile, String(process.pid), 'utf-8');",
			"process.on('SIGTERM', () => {",
			'  try { fs.unlinkSync(pidFile); } catch {}',
			'  process.exit(0);',
			'});',
			'setTimeout(() => {}, 60000);',
		].join(' ');

		child = spawn('node', ['-e', script, pidFile], { stdio: 'ignore' });
		const pid = child.pid as number;

		// Wait for the child to write its PID file
		let pidFileExists = false;
		for (let i = 0; i < 40; i++) {
			if (existsSync(pidFile)) {
				pidFileExists = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(pidFileExists).toBe(true);

		// Verify PID file content
		const content = await readFile(pidFile, 'utf-8');
		expect(Number.parseInt(content.trim(), 10)).toBe(pid);

		// Send SIGTERM
		process.kill(pid, 'SIGTERM');

		// Wait for exit
		const exited = await waitForExit(pid, 5000);
		expect(exited).toBe(true);

		// PID file should be cleaned up by the child
		expect(existsSync(pidFile)).toBe(false);
	});
});

// ─── Daemon stdio redirection to log files ───────────────────────────────────

describe('daemon stdio redirection', () => {
	let child: ChildProcess;

	afterEach(async () => {
		if (child?.pid && isProcessRunning(child.pid)) {
			try {
				process.kill(child.pid, 'SIGKILL');
			} catch {
				/* already dead */
			}
			await waitForExit(child.pid, 3000);
		}
	});

	it('stdout and stderr are captured in log files (not /dev/null)', async () => {
		// Mirrors apply.ts: open file descriptors, spawn with stdio redirected to them
		const logDir = join(testDir, 'logs');
		await mkdir(logDir, { recursive: true });

		const stdoutPath = join(logDir, 'daemon.stdout.log');
		const stderrPath = join(logDir, 'daemon.stderr.log');

		const stdoutFd = openSync(stdoutPath, 'a');
		const stderrFd = openSync(stderrPath, 'a');

		const script = [
			"console.log('daemon-stdout-marker');",
			"console.error('daemon-stderr-marker');",
			'process.exit(0);',
		].join(' ');

		child = spawn('node', ['-e', script], {
			stdio: ['ignore', stdoutFd, stderrFd],
		});

		closeSync(stdoutFd);
		closeSync(stderrFd);

		// Wait for exit
		const exited = await waitForExit(child.pid as number, 5000);
		expect(exited).toBe(true);

		// Verify log file contents
		const stdout = await readFile(stdoutPath, 'utf-8');
		const stderr = await readFile(stderrPath, 'utf-8');

		expect(stdout).toContain('daemon-stdout-marker');
		expect(stderr).toContain('daemon-stderr-marker');
	});

	it('log files append across restarts', async () => {
		const logDir = join(testDir, 'logs');
		await mkdir(logDir, { recursive: true });
		const stdoutPath = join(logDir, 'daemon.stdout.log');

		// First "run" — write initial content
		await writeFile(stdoutPath, 'first-run\n', 'utf-8');

		// Second "run" — open in append mode and spawn a child
		const stdoutFd = openSync(stdoutPath, 'a');

		child = spawn('node', ['-e', "console.log('second-run'); process.exit(0)"], {
			stdio: ['ignore', stdoutFd, 'ignore'],
		});

		closeSync(stdoutFd);
		await waitForExit(child.pid as number, 5000);

		const content = await readFile(stdoutPath, 'utf-8');
		expect(content).toContain('first-run');
		expect(content).toContain('second-run');
	});
});

// ─── Stop flow integration (mirrors stop.ts) ─────────────────────────────────

describe('stop flow', () => {
	let child: ChildProcess;

	afterEach(async () => {
		if (child?.pid && isProcessRunning(child.pid)) {
			try {
				process.kill(child.pid, 'SIGKILL');
			} catch {
				/* already dead */
			}
			await waitForExit(child.pid, 3000);
		}
	});

	it('reads PID from file, sends SIGTERM, waits, then cleans PID file', async () => {
		// Spawn a long-running process that handles SIGTERM
		child = spawn(
			'node',
			['-e', 'process.on("SIGTERM", () => process.exit(0)); setTimeout(() => {}, 60000)'],
			{ stdio: 'ignore' },
		);
		const pid = child.pid as number;
		await new Promise((r) => setTimeout(r, 100));

		// Write PID file (as apply.ts would)
		await writeFile(pidFile, String(pid), 'utf-8');

		// --- Execute stop.ts logic ---
		const pidStr = await readFile(pidFile, 'utf-8');
		const readPid = Number.parseInt(pidStr.trim(), 10);
		expect(readPid).toBe(pid);
		expect(isProcessRunning(readPid)).toBe(true);

		// Send SIGTERM
		process.kill(readPid, 'SIGTERM');

		// Wait for graceful exit
		const exited = await waitForExit(readPid, 5000);
		expect(exited).toBe(true);

		// Clean PID file
		await cleanupPidFile(pidFile);
		expect(existsSync(pidFile)).toBe(false);
	});

	it('SIGKILL escalation for unresponsive process', async () => {
		// Spawn a process that ignores SIGTERM (to test the --force / escalation path)
		child = spawn('node', ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000)'], {
			stdio: 'ignore',
		});
		const pid = child.pid as number;
		await new Promise((r) => setTimeout(r, 100));
		expect(isProcessRunning(pid)).toBe(true);

		// Send SIGTERM — process ignores it
		process.kill(pid, 'SIGTERM');

		// Short timeout — should NOT exit
		const exitedGracefully = await waitForExit(pid, 500);
		expect(exitedGracefully).toBe(false);
		expect(isProcessRunning(pid)).toBe(true);

		// Escalate to SIGKILL (mirrors stop.ts --force or timeout escalation)
		process.kill(pid, 'SIGKILL');

		const exitedForced = await waitForExit(pid, 3000);
		expect(exitedForced).toBe(true);
		expect(isProcessRunning(pid)).toBe(false);
	});

	it('stop handles no PID file gracefully', async () => {
		// Mirrors stop.ts: no PID file means nothing to stop
		let noPidFile = false;
		try {
			await readFile(pidFile, 'utf-8');
		} catch {
			noPidFile = true;
		}
		expect(noPidFile).toBe(true);
	});

	it('stop handles stale PID file (process already dead)', async () => {
		// Write PID of dead process
		await writeFile(pidFile, '99999999', 'utf-8');

		const pidStr = await readFile(pidFile, 'utf-8');
		const readPid = Number.parseInt(pidStr.trim(), 10);
		expect(isProcessRunning(readPid)).toBe(false);

		// Clean up stale PID file (as stop.ts does)
		await cleanupPidFile(pidFile);
		expect(existsSync(pidFile)).toBe(false);
	});
});
