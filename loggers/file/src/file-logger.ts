/**
 * JSONL file logger with buffering and rotation.
 *
 * The default production logger for OrgLoop.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { LogEntry, Logger } from '@orgloop/sdk';
import { parseDuration } from '@orgloop/sdk';
import { needsRotation, parseSize, type RotationConfig, rotateFile } from './rotation.js';

interface FileLoggerConfig {
	path?: string;
	format?: 'jsonl';
	rotation?: {
		max_size?: string;
		max_age?: string;
		max_files?: number;
		compress?: boolean;
	};
	buffer?: {
		size?: number;
		flush_interval?: string;
	};
}

export class FileLogger implements Logger {
	readonly id = 'file';
	private filePath = '';
	private buffer: string[] = [];
	private bufferSize = 100;
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	private rotation: RotationConfig = {
		maxSize: 100 * 1024 * 1024, // 100MB
		maxAge: 7 * 24 * 60 * 60 * 1000, // 7d
		maxFiles: 10,
		compress: true,
	};
	private dirEnsured = false;

	async init(config: Record<string, unknown>): Promise<void> {
		const cfg = config as FileLoggerConfig;

		// Resolve file path (expand ~ to home directory)
		const rawPath = cfg.path ?? `${homedir()}/.orgloop/logs/orgloop.log`;
		const expanded = rawPath.startsWith('~/') ? rawPath.replace('~', homedir()) : rawPath;
		this.filePath = resolve(expanded);

		// Parse rotation config
		if (cfg.rotation) {
			if (cfg.rotation.max_size) {
				this.rotation.maxSize = parseSize(cfg.rotation.max_size);
			}
			if (cfg.rotation.max_age) {
				this.rotation.maxAge = parseDuration(cfg.rotation.max_age);
			}
			if (cfg.rotation.max_files !== undefined) {
				this.rotation.maxFiles = cfg.rotation.max_files;
			}
			if (cfg.rotation.compress !== undefined) {
				this.rotation.compress = cfg.rotation.compress;
			}
		}

		// Parse buffer config
		if (cfg.buffer) {
			if (cfg.buffer.size !== undefined) {
				this.bufferSize = cfg.buffer.size;
			}
			if (cfg.buffer.flush_interval) {
				const intervalMs = parseDuration(cfg.buffer.flush_interval);
				this.flushTimer = setInterval(() => {
					void this.flush();
				}, intervalMs);
				if (this.flushTimer.unref) {
					this.flushTimer.unref();
				}
			}
		}

		// Default flush interval of 1s if not configured
		if (!this.flushTimer) {
			this.flushTimer = setInterval(() => {
				void this.flush();
			}, 1000);
			if (this.flushTimer.unref) {
				this.flushTimer.unref();
			}
		}

		// Create log file on init so tail -f works immediately
		await this.ensureDir();
		try {
			await appendFile(this.filePath, '', 'utf-8');
		} catch {
			// Best-effort — will retry on first flush
		}
	}

	async log(entry: LogEntry): Promise<void> {
		try {
			this.buffer.push(JSON.stringify(entry));
			if (this.buffer.length >= this.bufferSize) {
				await this.flush();
			}
		} catch {
			// Loggers must not throw
		}
	}

	async flush(): Promise<void> {
		if (this.buffer.length === 0) return;

		const entries = this.buffer.splice(0);
		const data = entries.map((e) => `${e}\n`).join('');

		try {
			await this.ensureDir();
			await appendFile(this.filePath, data, 'utf-8');

			// Check if rotation is needed
			if (await needsRotation(this.filePath, this.rotation.maxSize)) {
				await rotateFile(this.filePath, this.rotation);
			}
		} catch {
			// Loggers must not throw — entries are lost on write failure
		}
	}

	async shutdown(): Promise<void> {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
		await this.flush();
	}

	private async ensureDir(): Promise<void> {
		if (this.dirEnsured) return;
		try {
			await mkdir(dirname(this.filePath), { recursive: true });
			this.dirEnsured = true;
		} catch {
			// Directory may already exist
			this.dirEnsured = true;
		}
	}
}
