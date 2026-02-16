/**
 * Tests for FileLogger — JSONL write, buffering, rotation, path expansion, error resilience.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogEntry } from '@orgloop/sdk';
import { FileLogger } from '../file-logger.js';
import { needsRotation, parseSize, rotateFile } from '../rotation.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		timestamp: '2024-01-15T10:30:45.123Z',
		event_id: 'evt_abc123',
		trace_id: 'trc_xyz789',
		phase: 'deliver.success',
		source: 'github',
		target: 'openclaw',
		...overrides,
	};
}

let tmpDir: string;
let testCounter = 0;

function getTmpLogPath(): string {
	testCounter++;
	return join(tmpDir, `test-${testCounter}`, 'test.log');
}

beforeAll(async () => {
	tmpDir = join(tmpdir(), `orgloop-file-logger-test-${Date.now()}`);
});

afterAll(async () => {
	try {
		await rm(tmpDir, { recursive: true, force: true });
	} catch {
		// Cleanup is best-effort
	}
});

// ─── parseSize ───────────────────────────────────────────────────────────────

describe('parseSize', () => {
	it('parses bytes', () => {
		expect(parseSize('100B')).toBe(100);
	});

	it('parses kilobytes', () => {
		expect(parseSize('10KB')).toBe(10 * 1024);
	});

	it('parses megabytes', () => {
		expect(parseSize('100MB')).toBe(100 * 1024 * 1024);
	});

	it('parses gigabytes', () => {
		expect(parseSize('1GB')).toBe(1024 * 1024 * 1024);
	});

	it('parses decimal values', () => {
		expect(parseSize('1.5MB')).toBe(1.5 * 1024 * 1024);
	});

	it('is case-insensitive', () => {
		expect(parseSize('100mb')).toBe(100 * 1024 * 1024);
	});

	it('throws on invalid format', () => {
		expect(() => parseSize('abc')).toThrow('Invalid size format');
		expect(() => parseSize('100')).toThrow('Invalid size format');
		expect(() => parseSize('100TB')).toThrow('Invalid size format');
	});
});

// ─── needsRotation ───────────────────────────────────────────────────────────

describe('needsRotation', () => {
	it('returns false when file does not exist', async () => {
		const result = await needsRotation('/nonexistent/path.log', 100);
		expect(result).toBe(false);
	});

	it('returns false when file is under max size', async () => {
		const dir = join(tmpDir, `rotation-check-${testCounter++}`);
		await mkdir(dir, { recursive: true });
		const filePath = join(dir, 'small.log');
		await writeFile(filePath, 'hello');
		expect(await needsRotation(filePath, 1000)).toBe(false);
	});

	it('returns true when file meets or exceeds max size', async () => {
		const dir = join(tmpDir, `rotation-check-${testCounter++}`);
		await mkdir(dir, { recursive: true });
		const filePath = join(dir, 'big.log');
		await writeFile(filePath, 'x'.repeat(200));
		expect(await needsRotation(filePath, 200)).toBe(true);
		expect(await needsRotation(filePath, 100)).toBe(true);
	});
});

// ─── rotateFile ─────────────────────────────────────────────────────────────

describe('rotateFile', () => {
	it('renames the file to a timestamped name', async () => {
		const dir = join(tmpDir, `rotate-${testCounter++}`);
		await mkdir(dir, { recursive: true });
		const filePath = join(dir, 'app.log');
		await writeFile(filePath, 'data');

		await rotateFile(filePath, {
			maxSize: 0,
			maxAge: 365 * 24 * 60 * 60 * 1000,
			maxFiles: 10,
			compress: false,
		});

		const files = await readdir(dir);
		expect(files.some((f) => f.startsWith('app.log.'))).toBe(true);
		// Original file should be gone
		await expect(stat(filePath)).rejects.toThrow();
	});

	it('compresses rotated file when compress=true', async () => {
		const dir = join(tmpDir, `rotate-gz-${testCounter++}`);
		await mkdir(dir, { recursive: true });
		const filePath = join(dir, 'app.log');
		await writeFile(filePath, 'data to compress');

		await rotateFile(filePath, {
			maxSize: 0,
			maxAge: 365 * 24 * 60 * 60 * 1000,
			maxFiles: 10,
			compress: true,
		});

		const files = await readdir(dir);
		expect(files.some((f) => f.endsWith('.gz'))).toBe(true);
		// Uncompressed rotated file should have been removed
		const uncompressedRotated = files.filter((f) => f.startsWith('app.log.') && !f.endsWith('.gz'));
		expect(uncompressedRotated.length).toBe(0);
	});

	it('cleans up files exceeding maxFiles', async () => {
		const dir = join(tmpDir, `rotate-cleanup-${testCounter++}`);
		await mkdir(dir, { recursive: true });

		// Create fake rotated files
		for (let i = 0; i < 5; i++) {
			await writeFile(join(dir, `app.log.2025-01-0${i + 1}`), `data-${i}`);
		}

		const filePath = join(dir, 'app.log');
		await writeFile(filePath, 'current data');

		await rotateFile(filePath, {
			maxSize: 0,
			maxAge: 365 * 24 * 60 * 60 * 1000,
			maxFiles: 2,
			compress: false,
		});

		const files = await readdir(dir);
		const rotatedFiles = files.filter((f) => f.startsWith('app.log.'));
		expect(rotatedFiles.length).toBeLessThanOrEqual(2);
	});

	it('handles missing file gracefully', async () => {
		const dir = join(tmpDir, `rotate-missing-${testCounter++}`);
		await mkdir(dir, { recursive: true });
		await expect(
			rotateFile(join(dir, 'nonexistent.log'), {
				maxSize: 0,
				maxAge: 365 * 24 * 60 * 60 * 1000,
				maxFiles: 10,
				compress: false,
			}),
		).resolves.toBeUndefined();
	});
});

// ─── FileLogger ──────────────────────────────────────────────────────────────

describe('FileLogger', () => {
	it('writes valid JSONL entries', async () => {
		const logPath = getTmpLogPath();
		const logger = new FileLogger();
		await logger.init({
			path: logPath,
			buffer: { size: 1 }, // Flush after each entry
		});

		const entry = makeEntry();
		await logger.log(entry);
		await logger.shutdown();

		const content = await readFile(logPath, 'utf-8');
		const lines = content.trim().split('\n');
		expect(lines).toHaveLength(1);

		const parsed = JSON.parse(lines[0]);
		expect(parsed.event_id).toBe('evt_abc123');
		expect(parsed.phase).toBe('deliver.success');
		expect(parsed.source).toBe('github');
	});

	it('buffers entries until buffer size reached', async () => {
		const logPath = getTmpLogPath();
		const logger = new FileLogger();
		await logger.init({
			path: logPath,
			buffer: { size: 3, flush_interval: '60s' }, // Large interval, small buffer
		});

		// Write 2 entries — should not flush yet
		await logger.log(makeEntry({ event_id: 'evt_1' }));
		await logger.log(makeEntry({ event_id: 'evt_2' }));

		// File should exist but be empty (or near-empty) since buffer not full
		const content1 = await readFile(logPath, 'utf-8');
		expect(content1.trim()).toBe('');

		// Third entry should trigger flush
		await logger.log(makeEntry({ event_id: 'evt_3' }));

		const content2 = await readFile(logPath, 'utf-8');
		const lines = content2.trim().split('\n');
		expect(lines).toHaveLength(3);

		await logger.shutdown();
	});

	it('flushes remaining entries on shutdown', async () => {
		const logPath = getTmpLogPath();
		const logger = new FileLogger();
		await logger.init({
			path: logPath,
			buffer: { size: 100, flush_interval: '60s' }, // Big buffer, long interval
		});

		await logger.log(makeEntry({ event_id: 'evt_1' }));
		await logger.log(makeEntry({ event_id: 'evt_2' }));

		// Not yet flushed
		const beforeShutdown = await readFile(logPath, 'utf-8');
		expect(beforeShutdown.trim()).toBe('');

		// Shutdown triggers flush
		await logger.shutdown();

		const afterShutdown = await readFile(logPath, 'utf-8');
		const lines = afterShutdown.trim().split('\n');
		expect(lines).toHaveLength(2);
	});

	it('creates parent directories if missing', async () => {
		const logPath = join(tmpDir, `deep-${testCounter++}`, 'a', 'b', 'c', 'test.log');
		const logger = new FileLogger();
		await logger.init({ path: logPath, buffer: { size: 1 } });

		await logger.log(makeEntry());
		await logger.shutdown();

		const content = await readFile(logPath, 'utf-8');
		expect(content.trim()).not.toBe('');
	});

	it('creates log file on init', async () => {
		const logPath = getTmpLogPath();
		const logger = new FileLogger();
		await logger.init({ path: logPath });

		// File should exist even before any logs
		const st = await stat(logPath);
		expect(st.isFile()).toBe(true);

		await logger.shutdown();
	});

	it('does not throw on log failure', async () => {
		const logger = new FileLogger();
		// /dev/null is a character device, not a directory — mkdir fails with ENOTDIR instantly
		// (avoids /proc which hangs on Linux CI runners)
		await logger.init({ path: '/dev/null/nonexistent/test.log', buffer: { size: 1 } });

		// Should not throw
		await expect(logger.log(makeEntry())).resolves.toBeUndefined();
		await expect(logger.shutdown()).resolves.toBeUndefined();
	});

	it('handles multiple entries as separate JSONL lines', async () => {
		const logPath = getTmpLogPath();
		const logger = new FileLogger();
		await logger.init({ path: logPath, buffer: { size: 1 } });

		await logger.log(makeEntry({ event_id: 'evt_1', phase: 'source.emit' }));
		await logger.log(makeEntry({ event_id: 'evt_2', phase: 'deliver.success' }));
		await logger.shutdown();

		const content = await readFile(logPath, 'utf-8');
		const lines = content.trim().split('\n');
		expect(lines).toHaveLength(2);

		const first = JSON.parse(lines[0]);
		const second = JSON.parse(lines[1]);
		expect(first.event_id).toBe('evt_1');
		expect(second.event_id).toBe('evt_2');
	});

	it('rotation triggers when file exceeds max_size', async () => {
		const logPath = getTmpLogPath();
		const logDir = join(logPath, '..');
		const logger = new FileLogger();
		await logger.init({
			path: logPath,
			buffer: { size: 1 },
			rotation: {
				max_size: '100B', // Very small rotation threshold
				compress: false,
				max_files: 10,
			},
		});

		// Write enough entries to exceed 100 bytes
		for (let i = 0; i < 5; i++) {
			await logger.log(
				makeEntry({
					event_id: `evt_${i}`,
					metadata: { padding: 'x'.repeat(50) },
				}),
			);
		}

		await logger.shutdown();

		// Check that rotated files exist
		const files = await readdir(logDir);
		const rotatedFiles = files.filter((f) => f.startsWith('test.log.'));
		expect(rotatedFiles.length).toBeGreaterThan(0);
	});

	it('flush is idempotent when buffer is empty', async () => {
		const logPath = getTmpLogPath();
		const logger = new FileLogger();
		await logger.init({ path: logPath });

		await logger.flush();
		await logger.flush();
		await logger.flush();

		await logger.shutdown();
	});

	it('preserves all LogEntry fields in JSONL', async () => {
		const logPath = getTmpLogPath();
		const logger = new FileLogger();
		await logger.init({ path: logPath, buffer: { size: 1 } });

		const entry = makeEntry({
			event_id: 'evt_full',
			route: 'pr-review',
			event_type: 'resource.changed',
			transform: 'dedup',
			result: 'delivered',
			duration_ms: 42,
			error: 'timeout',
			metadata: { key: 'value' },
			orgloop_version: '0.1.0',
			hostname: 'test-host',
			workspace: 'test-ws',
			queue_depth: 5,
		});
		await logger.log(entry);
		await logger.shutdown();

		const content = await readFile(logPath, 'utf-8');
		const parsed = JSON.parse(content.trim());
		expect(parsed.event_id).toBe('evt_full');
		expect(parsed.route).toBe('pr-review');
		expect(parsed.transform).toBe('dedup');
		expect(parsed.duration_ms).toBe(42);
		expect(parsed.error).toBe('timeout');
		expect(parsed.metadata).toEqual({ key: 'value' });
		expect(parsed.orgloop_version).toBe('0.1.0');
		expect(parsed.hostname).toBe('test-host');
	});

	it('each JSONL line is individually parseable', async () => {
		const logPath = getTmpLogPath();
		const logger = new FileLogger();
		await logger.init({ path: logPath, buffer: { size: 1 } });

		for (let i = 0; i < 5; i++) {
			await logger.log(makeEntry({ event_id: `evt_${i}` }));
		}
		await logger.shutdown();

		const content = await readFile(logPath, 'utf-8');
		const lines = content.trim().split('\n');
		expect(lines.length).toBe(5);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});
});

// ─── register() ───────────────────────────────────────────────────────────────

describe('register()', () => {
	it('returns correct registration shape', async () => {
		const { register } = await import('../index.js');
		const reg = register();
		expect(reg.id).toBe('file');
		expect(reg.logger).toBe(FileLogger);
		expect(reg.configSchema).toBeDefined();
	});
});
