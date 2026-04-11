/**
 * Inbox Store — per-session-key event buffering for batched drain delivery.
 *
 * InboxStore interface + InMemoryInboxStore implementation.
 * Follows the same pattern as CheckpointStore/EventStore in store.ts.
 */

import type { OrgLoopEvent } from '@orgloop/sdk';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InboxEntry {
	id: number;
	sessionKey: string;
	event: OrgLoopEvent;
	createdAt: number; // epoch ms
	ttlExpiresAt: number; // epoch ms
	drainedAt: number | null;
}

export interface DrainResult {
	events: OrgLoopEvent[];
	remaining: number;
	continuation: string | null;
}

// ─── Interface ───────────────────────────────────────────────────────────────

export interface InboxStore {
	/** Enqueue an event for a session key. Returns the entry ID. */
	enqueue(sessionKey: string, event: OrgLoopEvent, ttlMs: number): Promise<number>;

	/** Atomically drain up to `limit` events for a session key. */
	drain(sessionKey: string, limit: number): Promise<DrainResult>;

	/** Count of pending (undrained, unexpired) events for a session key. */
	pending(sessionKey: string): Promise<number>;

	/** Remove entries past their TTL. Returns count expired. */
	expireStale(): Promise<number>;

	/** Cleanup resources. */
	close(): Promise<void>;
}

// ─── In-Memory Implementation ────────────────────────────────────────────────

export class InMemoryInboxStore implements InboxStore {
	private readonly entries = new Map<string, InboxEntry[]>();
	private nextId = 1;

	/** Per-key async lock: a promise chain that serializes drain operations. */
	private readonly locks = new Map<string, Promise<void>>();

	async enqueue(sessionKey: string, event: OrgLoopEvent, ttlMs: number): Promise<number> {
		const id = this.nextId++;
		const now = Date.now();
		const entry: InboxEntry = {
			id,
			sessionKey,
			event,
			createdAt: now,
			ttlExpiresAt: now + ttlMs,
			drainedAt: null,
		};

		let queue = this.entries.get(sessionKey);
		if (!queue) {
			queue = [];
			this.entries.set(sessionKey, queue);
		}
		queue.push(entry);

		return id;
	}

	async drain(sessionKey: string, limit: number): Promise<DrainResult> {
		// Serialize drain operations per session key
		const prev = this.locks.get(sessionKey) ?? Promise.resolve();
		let resolve!: () => void;
		const next = new Promise<void>((r) => {
			resolve = r;
		});
		this.locks.set(sessionKey, next);

		try {
			await prev;
			return this.doDrain(sessionKey, limit);
		} finally {
			resolve();
		}
	}

	private doDrain(sessionKey: string, limit: number): DrainResult {
		const queue = this.entries.get(sessionKey);
		if (!queue || queue.length === 0) {
			return { events: [], remaining: 0, continuation: null };
		}

		const now = Date.now();

		// Filter out expired entries in-place
		const live = queue.filter((e) => e.ttlExpiresAt > now);
		this.entries.set(sessionKey, live);

		if (live.length === 0) {
			return { events: [], remaining: 0, continuation: null };
		}

		// Take up to `limit` entries (oldest first — they're in insertion order)
		const batch = live.splice(0, limit);
		const remaining = live.length;
		const continuation = remaining > 0 ? String(batch[batch.length - 1].id) : null;

		// Mark as drained (for auditing; they're removed from the live queue already)
		const drainedAt = now;
		for (const entry of batch) {
			entry.drainedAt = drainedAt;
		}

		return {
			events: batch.map((e) => e.event),
			remaining,
			continuation,
		};
	}

	async pending(sessionKey: string): Promise<number> {
		const queue = this.entries.get(sessionKey);
		if (!queue) return 0;
		const now = Date.now();
		return queue.filter((e) => e.ttlExpiresAt > now).length;
	}

	async expireStale(): Promise<number> {
		const now = Date.now();
		let expired = 0;

		for (const [key, queue] of this.entries) {
			const before = queue.length;
			const live = queue.filter((e) => e.ttlExpiresAt > now);
			expired += before - live.length;

			if (live.length === 0) {
				this.entries.delete(key);
			} else {
				this.entries.set(key, live);
			}
		}

		return expired;
	}

	async close(): Promise<void> {
		this.entries.clear();
		this.locks.clear();
	}
}
