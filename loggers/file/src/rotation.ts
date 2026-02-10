/**
 * File rotation logic for the JSONL file logger.
 *
 * Handles: renaming current file to timestamped name, optional gzip compression,
 * and cleanup of old rotated files.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

export interface RotationConfig {
	maxSize: number;
	maxAge: number;
	maxFiles: number;
	compress: boolean;
}

/**
 * Parse a size string (e.g., "100MB", "1GB") to bytes.
 */
export function parseSize(size: string): number {
	const match = size.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i);
	if (!match) {
		throw new Error(
			`Invalid size format: "${size}". Expected format: <number><unit> (e.g., 100MB, 1GB)`,
		);
	}
	const value = Number.parseFloat(match[1]);
	const unit = match[2].toUpperCase();
	switch (unit) {
		case 'B':
			return value;
		case 'KB':
			return value * 1024;
		case 'MB':
			return value * 1024 * 1024;
		case 'GB':
			return value * 1024 * 1024 * 1024;
		default:
			throw new Error(`Unknown size unit: ${unit}`);
	}
}

/**
 * Check if a file exceeds the max size.
 */
export async function needsRotation(filePath: string, maxSize: number): Promise<boolean> {
	try {
		const st = await stat(filePath);
		return st.size >= maxSize;
	} catch {
		return false;
	}
}

/**
 * Rotate the current log file:
 * 1. Rename to timestamped name
 * 2. Optionally gzip
 * 3. Clean up old files
 */
export async function rotateFile(filePath: string, config: RotationConfig): Promise<void> {
	const dir = dirname(filePath);
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const baseName = filePath.split('/').pop() ?? 'log';
	const rotatedName = `${baseName}.${timestamp}`;
	const rotatedPath = join(dir, rotatedName);

	// Rename current → timestamped
	try {
		await rename(filePath, rotatedPath);
	} catch {
		// File may not exist or be locked; skip rotation
		return;
	}

	// Optionally compress
	if (config.compress) {
		try {
			const gzPath = `${rotatedPath}.gz`;
			await pipeline(createReadStream(rotatedPath), createGzip(), createWriteStream(gzPath));
			await unlink(rotatedPath);
		} catch {
			// Compression failed; leave the uncompressed file
		}
	}

	// Clean up old files
	await cleanupOldFiles(dir, baseName, config);
}

/**
 * Remove rotated files that exceed maxFiles or maxAge.
 */
async function cleanupOldFiles(
	dir: string,
	baseName: string,
	config: RotationConfig,
): Promise<void> {
	try {
		await mkdir(dir, { recursive: true });
		const files = await readdir(dir);

		// Find rotated files matching our base name
		const rotated: Array<{ name: string; mtime: number }> = [];
		for (const file of files) {
			if (file.startsWith(`${baseName}.`) && file !== baseName) {
				try {
					const st = await stat(join(dir, file));
					rotated.push({ name: file, mtime: st.mtimeMs });
				} catch {
					// Skip files we can't stat
				}
			}
		}

		// Sort by mtime descending (newest first)
		rotated.sort((a, b) => b.mtime - a.mtime);

		const now = Date.now();
		for (let i = 0; i < rotated.length; i++) {
			const entry = rotated[i];
			const isOverLimit = i >= config.maxFiles;
			const isExpired = now - entry.mtime > config.maxAge;

			if (isOverLimit || isExpired) {
				try {
					await unlink(join(dir, entry.name));
				} catch {
					// Best effort cleanup
				}
			}
		}
	} catch {
		// Directory issues — skip cleanup
	}
}
