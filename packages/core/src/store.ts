/**
 * Event store + checkpoint persistence.
 *
 * CheckpointStore: persists source poll checkpoints for crash recovery.
 * EventStore: append-only JSONL WAL for at-least-once delivery guarantee.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OrgLoopEvent } from '@orgloop/sdk';

// ─── Checkpoint Store ─────────────────────────────────────────────────────────

export interface CheckpointStore {
	get(sourceId: string): Promise<string | null>;
	set(sourceId: string, checkpoint: string): Promise<void>;
}

export class FileCheckpointStore implements CheckpointStore {
	private readonly dir: string;

	constructor(dataDir?: string) {
		this.dir = dataDir
			? join(dataDir, 'checkpoints')
			: join(homedir(), '.orgloop', 'data', 'checkpoints');
	}

	private filePath(sourceId: string): string {
		return join(this.dir, `${sourceId}.json`);
	}

	async get(sourceId: string): Promise<string | null> {
		try {
			const content = await readFile(this.filePath(sourceId), 'utf-8');
			const data = JSON.parse(content) as { checkpoint: string };
			return data.checkpoint;
		} catch {
			return null;
		}
	}

	async set(sourceId: string, checkpoint: string): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		await writeFile(
			this.filePath(sourceId),
			JSON.stringify({ checkpoint, updated_at: new Date().toISOString() }),
			'utf-8',
		);
	}
}

// ─── WAL Entry ────────────────────────────────────────────────────────────────

export interface WalEntry {
	id: string;
	event: OrgLoopEvent;
	written_at: string;
	acked: boolean;
}

// ─── Event Store (WAL) ───────────────────────────────────────────────────────

export interface EventStore {
	write(event: OrgLoopEvent): Promise<WalEntry>;
	ack(entryId: string): Promise<void>;
	unacked(): Promise<WalEntry[]>;
}

export class FileEventStore implements EventStore {
	private readonly walDir: string;
	private readonly walFile: string;
	private readonly ackedSet = new Set<string>();

	constructor(dataDir?: string) {
		this.walDir = dataDir ? join(dataDir, 'wal') : join(homedir(), '.orgloop', 'data', 'wal');
		this.walFile = join(this.walDir, 'events.jsonl');
	}

	async write(event: OrgLoopEvent): Promise<WalEntry> {
		await mkdir(this.walDir, { recursive: true });
		const entry: WalEntry = {
			id: event.id,
			event,
			written_at: new Date().toISOString(),
			acked: false,
		};
		await appendFile(this.walFile, `${JSON.stringify(entry)}\n`, 'utf-8');
		return entry;
	}

	async ack(entryId: string): Promise<void> {
		this.ackedSet.add(entryId);
		// Write ack marker to WAL
		await mkdir(this.walDir, { recursive: true });
		await appendFile(
			this.walFile,
			`${JSON.stringify({ type: 'ack', id: entryId, acked_at: new Date().toISOString() })}\n`,
			'utf-8',
		);
	}

	async unacked(): Promise<WalEntry[]> {
		let content: string;
		try {
			content = await readFile(this.walFile, 'utf-8');
		} catch {
			return [];
		}

		const entries = new Map<string, WalEntry>();
		const acked = new Set(this.ackedSet);

		for (const line of content.split('\n')) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as Record<string, unknown>;
				if (parsed.type === 'ack') {
					acked.add(parsed.id as string);
				} else {
					const entry = parsed as unknown as WalEntry;
					entries.set(entry.id, entry);
				}
			} catch {
				// Skip malformed lines
			}
		}

		// Return entries not acked
		const result: WalEntry[] = [];
		for (const [id, entry] of entries) {
			if (!acked.has(id)) {
				result.push(entry);
			}
		}
		return result;
	}
}

// ─── In-memory stores (for testing) ──────────────────────────────────────────

export class InMemoryCheckpointStore implements CheckpointStore {
	private readonly data = new Map<string, string>();

	async get(sourceId: string): Promise<string | null> {
		return this.data.get(sourceId) ?? null;
	}

	async set(sourceId: string, checkpoint: string): Promise<void> {
		this.data.set(sourceId, checkpoint);
	}
}

export class InMemoryEventStore implements EventStore {
	private readonly entries = new Map<string, WalEntry>();
	private readonly ackedSet = new Set<string>();

	async write(event: OrgLoopEvent): Promise<WalEntry> {
		const entry: WalEntry = {
			id: event.id,
			event,
			written_at: new Date().toISOString(),
			acked: false,
		};
		this.entries.set(entry.id, entry);
		return entry;
	}

	async ack(entryId: string): Promise<void> {
		this.ackedSet.add(entryId);
	}

	async unacked(): Promise<WalEntry[]> {
		const result: WalEntry[] = [];
		for (const [id, entry] of this.entries) {
			if (!this.ackedSet.has(id)) {
				result.push(entry);
			}
		}
		return result;
	}
}
