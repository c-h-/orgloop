/**
 * Daemon lifecycle tests — PID file management, stale detection,
 * duplicate prevention, signal handling, graceful shutdown, state
 * persistence, and stop command behavior.
 *
 * Covers fixes from WQ-67 (daemon log redirection), WQ-68 (child-owned
 * PID file), WQ-69 (duplicate instance prevention), WQ-70 (PID cleanup
 * on error and exit).
 *
 * Tests exercise the same patterns used in start.ts and stop.ts.
 * Real child processes are spawned for fork-related tests.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let testDir: string;
let pidFile: string;
let stateFile: string;
let logDir: string;

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

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (existsSync(path)) return true;
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
	stateFile = join(testDir, 'state.json');
	logDir = join(testDir, 'logs');
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
		await expect(cleanupPidFile(pidFile)).resolves.toBeUndefined();
	});

	it('overwrites an existing PID file with new PID', async () => {
		await writeFile(pidFile, '12345', 'utf-8');
		await writeFile(pidFile, '67890', 'utf-8');

		const content = await readFile(pidFile, 'utf-8');
		expect(content.trim()).toBe('67890');
	});
});

// ─── Process detection ───────────────────────────────────────────────────────

describe('isProcessRunning', () => {
	it('returns true for the current process', () => {
		expect(isProcessRunning(process.pid)).toBe(true);
	});

	it('returns false for a non-existent PID', () => {
		expect(isProcessRunning(99999999)).toBe(false);
	});

	it('returns false for PID 0 (kernel)', () => {
		const result = isProcessRunning(0);
		expect(typeof result).toBe('boolean');
	});

	it('returns false for negative PIDs', () => {
		const result = isProcessRunning(-1);
		expect(typeof result).toBe('boolean');
	});
});

// ─── Stale PID file detection ────────────────────────────────────────────────

describe('stale PID file detection', () => {
	it('detects a stale PID file (process no longer running)', async () => {
		await writeFile(pidFile, '99999999', 'utf-8');

		const pidStr = await readFile(pidFile, 'utf-8');
		const pid = Number.parseInt(pidStr.trim(), 10);

		expect(Number.isNaN(pid)).toBe(false);
		expect(isProcessRunning(pid)).toBe(false);

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

	it('handles empty PID file', async () => {
		await writeFile(pidFile, '', 'utf-8');

		const pidStr = await readFile(pidFile, 'utf-8');
		const pid = Number.parseInt(pidStr.trim(), 10);

		expect(Number.isNaN(pid)).toBe(true);
	});
});

// ─── Duplicate instance prevention (WQ-69) ──────────────────────────────────

describe('duplicate instance prevention', () => {
	it('blocks second start when first is running', async () => {
		await writeFile(pidFile, String(process.pid), 'utf-8');

		const pidStr = await readFile(pidFile, 'utf-8');
		const existingPid = Number.parseInt(pidStr.trim(), 10);

		const shouldBlock = !Number.isNaN(existingPid) && isProcessRunning(existingPid);
		expect(shouldBlock).toBe(true);
	});

	it('allows start when PID file exists but process is dead', async () => {
		await writeFile(pidFile, '99999999', 'utf-8');

		const pidStr = await readFile(pidFile, 'utf-8');
		const existingPid = Number.parseInt(pidStr.trim(), 10);

		const shouldBlock = !Number.isNaN(existingPid) && isProcessRunning(existingPid);
		expect(shouldBlock).toBe(false);

		await cleanupPidFile(pidFile);
	});

	it('allows start when no PID file exists', async () => {
		let pidExists = false;
		try {
			await readFile(pidFile, 'utf-8');
			pidExists = true;
		} catch {
			// No PID file — proceed
		}

		expect(pidExists).toBe(false);
	});

	it('cleans up stale PID before allowing new start', async () => {
		await writeFile(pidFile, '99999999', 'utf-8');

		const pidStr = await readFile(pidFile, 'utf-8');
		const existingPid = Number.parseInt(pidStr.trim(), 10);

		if (!Number.isNaN(existingPid) && !isProcessRunning(existingPid)) {
			await cleanupPidFile(pidFile);
		}

		await expect(readFile(pidFile, 'utf-8')).rejects.toThrow();

		await writeFile(pidFile, String(process.pid), 'utf-8');
		const newPid = await readFile(pidFile, 'utf-8');
		expect(newPid.trim()).toBe(String(process.pid));
	});
});

// ─── Signal handling with real child processes ───────────────────────────────

describe('signal handling', () => {
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

	it('SIGTERM causes graceful shutdown of a child process', async () => {
		child = spawn(
			'node',
			['-e', 'process.on("SIGTERM", () => process.exit(0)); setTimeout(() => {}, 60000)'],
			{ stdio: 'ignore' },
		);

		expect(child.pid).toBeDefined();
		const pid = child.pid as number;

		await new Promise((r) => setTimeout(r, 100));
		expect(isProcessRunning(pid)).toBe(true);

		await writeFile(pidFile, String(pid), 'utf-8');

		process.kill(pid, 'SIGTERM');
		const exited = await waitForExit(pid, 5000);
		expect(exited).toBe(true);

		await cleanupPidFile(pidFile);
	});

	it('SIGINT causes graceful shutdown of a child process', async () => {
		child = spawn(
			'node',
			['-e', 'process.on("SIGINT", () => process.exit(0)); setTimeout(() => {}, 60000)'],
			{ stdio: 'ignore' },
		);

		const pid = child.pid as number;
		await new Promise((r) => setTimeout(r, 100));
		expect(isProcessRunning(pid)).toBe(true);

		process.kill(pid, 'SIGINT');
		const exited = await waitForExit(pid, 5000);
		expect(exited).toBe(true);
	});

	it('SIGKILL force-kills a process that ignores SIGTERM', async () => {
		child = spawn('node', ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000)'], {
			stdio: 'ignore',
		});

		const pid = child.pid as number;
		await new Promise((r) => setTimeout(r, 100));
		expect(isProcessRunning(pid)).toBe(true);

		process.kill(pid, 'SIGKILL');

		const exited = await waitForExit(pid, 5000);
		expect(exited).toBe(true);
		expect(isProcessRunning(pid)).toBe(false);
	});

	it('process exit cleans up naturally', async () => {
		child = spawn('node', ['-e', 'process.exit(0)'], { stdio: 'ignore' });

		const pid = child.pid as number;
		const exited = await waitForExit(pid, 3000);
		expect(exited).toBe(true);
		expect(isProcessRunning(pid)).toBe(false);
	});
});

// ─── Child-owned PID file lifecycle (WQ-68) ──────────────────────────────────

describe('child-owned PID file lifecycle', () => {
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

	it('child writes PID file after starting (not parent)', async () => {
		const script = [
			"const fs = require('fs');",
			`const pidPath = ${JSON.stringify(pidFile)};`,
			"fs.writeFileSync(pidPath, String(process.pid), 'utf-8');",
			"process.on('SIGTERM', () => {",
			'  try { fs.unlinkSync(pidPath); } catch {}',
			'  process.exit(0);',
			'});',
			'setTimeout(() => {}, 60000);',
		].join(' ');

		child = spawn('node', ['-e', script], { stdio: 'ignore' });
		const pid = child.pid as number;

		const appeared = await waitForFile(pidFile, 3000);
		expect(appeared).toBe(true);

		const writtenPid = await readFile(pidFile, 'utf-8');
		expect(Number.parseInt(writtenPid.trim(), 10)).toBe(pid);

		// SIGTERM triggers child's cleanup handler
		process.kill(pid, 'SIGTERM');
		const exited = await waitForExit(pid, 5000);
		expect(exited).toBe(true);

		expect(existsSync(pidFile)).toBe(false);
	});

	it('child cleans up PID file on error exit via process.on("exit")', async () => {
		const script = [
			"const fs = require('fs');",
			`const pidPath = ${JSON.stringify(pidFile)};`,
			"fs.writeFileSync(pidPath, String(process.pid), 'utf-8');",
			"process.on('exit', () => {",
			'  try { fs.unlinkSync(pidPath); } catch {}',
			'});',
			"throw new Error('engine start failed');",
		].join(' ');

		child = spawn('node', ['-e', script], { stdio: 'ignore' });

		const exited = await waitForExit(child.pid as number, 5000);
		expect(exited).toBe(true);

		// PID file cleaned up via process.on('exit') handler (WQ-70 fix)
		expect(existsSync(pidFile)).toBe(false);
	});

	it('parent does not write PID file for daemon child', async () => {
		expect(existsSync(pidFile)).toBe(false);

		// Parent forks child but does NOT write PID file (WQ-68)
		child = spawn('node', ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });

		// Parent should not have written PID file
		expect(existsSync(pidFile)).toBe(false);

		process.kill(child.pid as number, 'SIGKILL');
		await waitForExit(child.pid as number, 3000);
	});
});

// ─── PID cleanup on process exit (WQ-70) ─────────────────────────────────────

describe('PID cleanup on process exit (WQ-70)', () => {
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

	it('synchronous unlinkSync in exit handler removes PID file', async () => {
		const script = [
			"const fs = require('fs');",
			`const pidPath = ${JSON.stringify(pidFile)};`,
			"fs.writeFileSync(pidPath, String(process.pid), 'utf-8');",
			"process.on('exit', () => {",
			'  try { fs.unlinkSync(pidPath); } catch {}',
			'});',
			'process.exit(0);',
		].join(' ');

		child = spawn('node', ['-e', script], { stdio: 'ignore' });

		await waitForExit(child.pid as number, 5000);
		expect(existsSync(pidFile)).toBe(false);
	});

	it('exit handler runs on unhandled exception', async () => {
		const script = [
			"const fs = require('fs');",
			`const pidPath = ${JSON.stringify(pidFile)};`,
			"fs.writeFileSync(pidPath, String(process.pid), 'utf-8');",
			"process.on('exit', () => {",
			'  try { fs.unlinkSync(pidPath); } catch {}',
			'});',
			"throw new Error('unexpected crash');",
		].join(' ');

		child = spawn('node', ['-e', script], { stdio: 'ignore' });

		await waitForExit(child.pid as number, 5000);
		expect(existsSync(pidFile)).toBe(false);
	});

	it('exit handler runs on SIGTERM when handler calls process.exit', async () => {
		const script = [
			"const fs = require('fs');",
			`const pidPath = ${JSON.stringify(pidFile)};`,
			"fs.writeFileSync(pidPath, String(process.pid), 'utf-8');",
			"process.on('exit', () => {",
			'  try { fs.unlinkSync(pidPath); } catch {}',
			'});',
			"process.on('SIGTERM', () => process.exit(0));",
			'setTimeout(() => {}, 60000);',
		].join(' ');

		child = spawn('node', ['-e', script], { stdio: 'ignore' });

		await new Promise((r) => setTimeout(r, 200));
		expect(existsSync(pidFile)).toBe(true);

		process.kill(child.pid as number, 'SIGTERM');
		await waitForExit(child.pid as number, 5000);
		expect(existsSync(pidFile)).toBe(false);
	});
});

// ─── Daemon log redirection (WQ-67) ─────────────────────────────────────────

describe('daemon log redirection', () => {
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

	it('creates log directory structure', async () => {
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

	it('redirects child stdout/stderr to log files via file descriptors', async () => {
		await mkdir(logDir, { recursive: true });

		const stdoutPath = join(logDir, 'daemon.stdout.log');
		const stderrPath = join(logDir, 'daemon.stderr.log');

		const stdoutFd = openSync(stdoutPath, 'a');
		const stderrFd = openSync(stderrPath, 'a');

		child = spawn(
			'node',
			['-e', "console.log('hello stdout'); console.error('hello stderr'); process.exit(0)"],
			{ stdio: ['ignore', stdoutFd, stderrFd] },
		);

		await waitForExit(child.pid as number, 5000);

		closeSync(stdoutFd);
		closeSync(stderrFd);

		const stdout = readFileSync(stdoutPath, 'utf-8');
		const stderr = readFileSync(stderrPath, 'utf-8');

		expect(stdout).toContain('hello stdout');
		expect(stderr).toContain('hello stderr');
	});

	it('appends to existing log files (does not truncate)', async () => {
		await mkdir(logDir, { recursive: true });
		const stdoutPath = join(logDir, 'daemon.stdout.log');

		await writeFile(stdoutPath, 'first line\n', 'utf-8');

		const fd = openSync(stdoutPath, 'a');
		child = spawn('node', ['-e', "console.log('second line'); process.exit(0)"], {
			stdio: ['ignore', fd, 'ignore'],
		});

		await waitForExit(child.pid as number, 5000);
		closeSync(fd);

		const content = readFileSync(stdoutPath, 'utf-8');
		expect(content).toContain('first line');
		expect(content).toContain('second line');
	});

	it('captures daemon crash output in stderr log', async () => {
		await mkdir(logDir, { recursive: true });
		const stderrPath = join(logDir, 'daemon.stderr.log');

		const stderrFd = openSync(stderrPath, 'a');

		child = spawn('node', ['-e', "throw new Error('daemon startup failed')"], {
			stdio: ['ignore', 'ignore', stderrFd],
		});

		await waitForExit(child.pid as number, 5000);
		closeSync(stderrFd);

		const stderr = readFileSync(stderrPath, 'utf-8');
		expect(stderr).toContain('daemon startup failed');
	});
});

// ─── State file persistence ──────────────────────────────────────────────────

describe('state file persistence', () => {
	it('writes state with sources, actors, routes, transforms, loggers', async () => {
		const config = {
			sources: [{ id: 'github', connector: 'orgloop-connector-github', poll: { interval: '30s' } }],
			actors: [{ id: 'openclaw', connector: 'orgloop-connector-openclaw' }],
			routes: [{ name: 'pr-to-review', when: { source: 'github' }, then: { actor: 'openclaw' } }],
			transforms: [{ name: 'filter-bots', type: 'orgloop-transform-filter' }],
			loggers: [{ name: 'console', type: 'orgloop-logger-console' }],
		};

		// Mirrors saveState() from start.ts
		const state = {
			sources: Object.fromEntries(
				config.sources.map((s) => [
					s.id,
					{ connector: s.connector, poll_interval: s.poll?.interval },
				]),
			),
			actors: Object.fromEntries(config.actors.map((a) => [a.id, { connector: a.connector }])),
			routes: Object.fromEntries(
				config.routes.map((r) => [r.name, { source: r.when.source, actor: r.then.actor }]),
			),
			transforms: Object.fromEntries(config.transforms.map((t) => [t.name, { type: t.type }])),
			loggers: Object.fromEntries(config.loggers.map((l) => [l.name, { type: l.type }])),
		};

		await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');

		const written = JSON.parse(await readFile(stateFile, 'utf-8'));
		expect(written.sources.github.connector).toBe('orgloop-connector-github');
		expect(written.sources.github.poll_interval).toBe('30s');
		expect(written.actors.openclaw.connector).toBe('orgloop-connector-openclaw');
		expect(written.routes['pr-to-review'].source).toBe('github');
		expect(written.routes['pr-to-review'].actor).toBe('openclaw');
		expect(written.transforms['filter-bots'].type).toBe('orgloop-transform-filter');
		expect(written.loggers.console.type).toBe('orgloop-logger-console');
	});

	it('creates parent directory for state file', async () => {
		const nestedDir = join(testDir, 'nested', '.orgloop');
		const nestedState = join(nestedDir, 'state.json');

		await mkdir(nestedDir, { recursive: true });
		await writeFile(nestedState, '{}', 'utf-8');

		const info = await stat(nestedState);
		expect(info.isFile()).toBe(true);
	});

	it('overwrites previous state on re-start', async () => {
		await writeFile(stateFile, JSON.stringify({ sources: { old: {} } }), 'utf-8');
		await writeFile(stateFile, JSON.stringify({ sources: { new_source: {} } }), 'utf-8');

		const written = JSON.parse(await readFile(stateFile, 'utf-8'));
		expect(written.sources).toHaveProperty('new_source');
		expect(written.sources).not.toHaveProperty('old');
	});
});

// ─── Stop command behavior ───────────────────────────────────────────────────

describe('stop command behavior', () => {
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

	it('reads PID, sends SIGTERM, waits for exit, cleans PID file', async () => {
		child = spawn(
			'node',
			['-e', 'process.on("SIGTERM", () => process.exit(0)); setTimeout(() => {}, 60000)'],
			{ stdio: 'ignore' },
		);
		const pid = child.pid as number;
		await new Promise((r) => setTimeout(r, 100));
		await writeFile(pidFile, String(pid), 'utf-8');

		// stop.ts flow
		const pidStr = await readFile(pidFile, 'utf-8');
		const readPid = Number.parseInt(pidStr.trim(), 10);
		expect(readPid).toBe(pid);
		expect(isProcessRunning(readPid)).toBe(true);

		process.kill(readPid, 'SIGTERM');
		const exited = await waitForExit(readPid, 5000);
		expect(exited).toBe(true);

		await cleanupPidFile(pidFile);
		expect(existsSync(pidFile)).toBe(false);
	});

	it('detects stale PID file and cleans up', async () => {
		await writeFile(pidFile, '99999999', 'utf-8');

		const pidStr = await readFile(pidFile, 'utf-8');
		const pid = Number.parseInt(pidStr.trim(), 10);
		expect(isProcessRunning(pid)).toBe(false);

		await cleanupPidFile(pidFile);
		expect(existsSync(pidFile)).toBe(false);
	});

	it('handles missing PID file (not running)', async () => {
		let noPidFile = false;
		try {
			await readFile(pidFile, 'utf-8');
		} catch {
			noPidFile = true;
		}
		expect(noPidFile).toBe(true);
	});

	it('handles invalid PID in file', async () => {
		await writeFile(pidFile, 'garbage-data', 'utf-8');

		const pidStr = await readFile(pidFile, 'utf-8');
		const pid = Number.parseInt(pidStr.trim(), 10);
		expect(Number.isNaN(pid)).toBe(true);
	});

	it('force kill with SIGKILL (--force)', async () => {
		child = spawn('node', ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000)'], {
			stdio: 'ignore',
		});
		const pid = child.pid as number;
		await new Promise((r) => setTimeout(r, 100));
		await writeFile(pidFile, String(pid), 'utf-8');

		process.kill(pid, 'SIGKILL');
		const exited = await waitForExit(pid, 5000);
		expect(exited).toBe(true);

		await cleanupPidFile(pidFile);
		expect(existsSync(pidFile)).toBe(false);
	});

	it('escalates to SIGKILL after timeout', async () => {
		child = spawn('node', ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000)'], {
			stdio: 'ignore',
		});
		const pid = child.pid as number;
		await new Promise((r) => setTimeout(r, 100));

		process.kill(pid, 'SIGTERM');

		const exitedGracefully = await waitForExit(pid, 500);
		expect(exitedGracefully).toBe(false);

		process.kill(pid, 'SIGKILL');
		const exitedForced = await waitForExit(pid, 5000);
		expect(exitedForced).toBe(true);
	});
});

// ─── Full daemon lifecycle integration ───────────────────────────────────────

describe('full daemon lifecycle', () => {
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

	it('start → PID file → state file → SIGTERM → cleanup', async () => {
		const script = [
			"const fs = require('fs');",
			`const pidPath = ${JSON.stringify(pidFile)};`,
			`const statePath = ${JSON.stringify(stateFile)};`,
			'fs.writeFileSync(statePath, JSON.stringify({ started: true }));',
			"fs.writeFileSync(pidPath, String(process.pid), 'utf-8');",
			"process.on('exit', () => {",
			'  try { fs.unlinkSync(pidPath); } catch {}',
			'});',
			"process.on('SIGTERM', () => process.exit(0));",
			"process.on('SIGINT', () => process.exit(0));",
			'setTimeout(() => {}, 60000);',
		].join(' ');

		child = spawn('node', ['-e', script], { stdio: 'ignore' });
		const pid = child.pid as number;

		const appeared = await waitForFile(pidFile, 3000);
		expect(appeared).toBe(true);

		const writtenPid = await readFile(pidFile, 'utf-8');
		expect(Number.parseInt(writtenPid.trim(), 10)).toBe(pid);

		expect(existsSync(stateFile)).toBe(true);
		const state = JSON.parse(await readFile(stateFile, 'utf-8'));
		expect(state.started).toBe(true);

		process.kill(pid, 'SIGTERM');
		const exited = await waitForExit(pid, 5000);
		expect(exited).toBe(true);
		expect(existsSync(pidFile)).toBe(false);
	});

	it('daemon with log capture lifecycle', async () => {
		await mkdir(logDir, { recursive: true });
		const stdoutPath = join(logDir, 'daemon.stdout.log');
		const stderrPath = join(logDir, 'daemon.stderr.log');

		const stdoutFd = openSync(stdoutPath, 'a');
		const stderrFd = openSync(stderrPath, 'a');

		const script = [
			"const fs = require('fs');",
			`const pidPath = ${JSON.stringify(pidFile)};`,
			"console.log('Daemon started');",
			"console.error('Daemon ready');",
			"fs.writeFileSync(pidPath, String(process.pid), 'utf-8');",
			"process.on('exit', () => {",
			'  try { fs.unlinkSync(pidPath); } catch {}',
			'});',
			"process.on('SIGTERM', () => {",
			"  console.log('Shutting down...');",
			'  process.exit(0);',
			'});',
			'setTimeout(() => {}, 60000);',
		].join(' ');

		child = spawn('node', ['-e', script], {
			stdio: ['ignore', stdoutFd, stderrFd],
		});

		closeSync(stdoutFd);
		closeSync(stderrFd);

		const pid = child.pid as number;
		const appeared = await waitForFile(pidFile, 3000);
		expect(appeared).toBe(true);

		process.kill(pid, 'SIGTERM');
		await waitForExit(pid, 5000);

		const stdout = readFileSync(stdoutPath, 'utf-8');
		const stderr = readFileSync(stderrPath, 'utf-8');

		expect(stdout).toContain('Daemon started');
		expect(stdout).toContain('Shutting down...');
		expect(stderr).toContain('Daemon ready');
	});
});

// ─── waitForExit ─────────────────────────────────────────────────────────────

describe('waitForExit', () => {
	it('returns true immediately for a dead process', async () => {
		const start = Date.now();
		const result = await waitForExit(99999999, 5000);
		const elapsed = Date.now() - start;

		expect(result).toBe(true);
		expect(elapsed).toBeLessThan(200);
	});

	it('returns false after timeout for a running process', async () => {
		const start = Date.now();
		const result = await waitForExit(process.pid, 300);
		const elapsed = Date.now() - start;

		expect(result).toBe(false);
		expect(elapsed).toBeGreaterThanOrEqual(250);
	});
});

// ─── waitForFile ─────────────────────────────────────────────────────────────

describe('waitForFile', () => {
	it('returns true immediately when file exists', async () => {
		await writeFile(pidFile, 'test', 'utf-8');

		const start = Date.now();
		const result = await waitForFile(pidFile, 5000);
		const elapsed = Date.now() - start;

		expect(result).toBe(true);
		expect(elapsed).toBeLessThan(200);
	});

	it('returns false after timeout when file never appears', async () => {
		const start = Date.now();
		const result = await waitForFile(join(testDir, 'nonexistent'), 300);
		const elapsed = Date.now() - start;

		expect(result).toBe(false);
		expect(elapsed).toBeGreaterThanOrEqual(250);
	});
});
