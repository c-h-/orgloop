/**
 * Inbox Manager — orchestrates enqueue, notification suppression, and drain.
 *
 * State machine per session key:
 *   Events arrive → enqueue → check notification state
 *     If no notification pending → fire onNotify callback → set flag
 *     If notification pending → skip (events accumulate silently)
 *   Agent drains → atomically fetch events → clear flag → re-notify if new events
 */

import type { OrgLoopEvent } from '@orgloop/sdk';
import { parseDuration } from '@orgloop/sdk';
import type { DrainResult, InboxStore } from './inbox-store.js';
import { InMemoryInboxStore } from './inbox-store.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InboxConfig {
	/** Enable inbox for this route (default: false) */
	inbox?: boolean;
	/** Session key template, interpolated with event data */
	session_key?: string;
	/** Event TTL (default: "1h") */
	inbox_ttl?: string;
	/** Max events per drain batch (default: 100) */
	inbox_max_batch?: number;
}

export interface InboxManagerOptions {
	/** Backing store (default: InMemoryInboxStore) */
	store?: InboxStore;
	/** Default TTL for events (default: "1h") */
	defaultTtl?: string;
	/** Default max batch size (default: 100) */
	defaultMaxBatch?: number;
	/** Stale entry cleanup interval (default: "5m") */
	cleanupInterval?: string;
}

// ─── InboxManager ────────────────────────────────────────────────────────────

export class InboxManager {
	private readonly store: InboxStore;
	private readonly defaultTtlMs: number;
	private readonly defaultMaxBatch: number;
	private readonly cleanupIntervalMs: number;

	/** Tracks whether a notification is in-flight for a session key. */
	private readonly notificationPending = new Map<string, boolean>();

	/** Cleanup timer handle. */
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	/**
	 * Notification callback — set by the runtime to deliver "you have mail" POST.
	 * Called with (sessionKey, pendingCount, oldestEventTimestamp).
	 */
	onNotify:
		| ((sessionKey: string, pendingCount: number, oldestEventAt: string) => Promise<void>)
		| null = null;

	constructor(options?: InboxManagerOptions) {
		this.store = options?.store ?? new InMemoryInboxStore();
		this.defaultTtlMs = parseDuration(options?.defaultTtl ?? '1h');
		this.defaultMaxBatch = options?.defaultMaxBatch ?? 100;
		this.cleanupIntervalMs = parseDuration(options?.cleanupInterval ?? '5m');
	}

	/**
	 * Enqueue an event for a session key. Sends a notification if one isn't
	 * already pending.
	 */
	async enqueue(sessionKey: string, event: OrgLoopEvent, config: InboxConfig): Promise<void> {
		const ttlMs = config.inbox_ttl ? parseDuration(config.inbox_ttl) : this.defaultTtlMs;

		await this.store.enqueue(sessionKey, event, ttlMs);

		// If no notification is pending, send one
		if (!this.notificationPending.get(sessionKey)) {
			await this.sendNotification(sessionKey);
		}
	}

	/**
	 * Drain up to `limit` events for a session key.
	 * Clears the notification flag and re-notifies if new events arrived.
	 */
	async drain(sessionKey: string, limit?: number): Promise<DrainResult> {
		const maxBatch = limit ?? this.defaultMaxBatch;
		const result = await this.store.drain(sessionKey, maxBatch);

		// Clear notification flag
		this.notificationPending.set(sessionKey, false);

		// Check if new events arrived during drain — if so, re-notify
		const stillPending = await this.store.pending(sessionKey);
		if (stillPending > 0) {
			await this.sendNotification(sessionKey);
		}

		return result;
	}

	/** Get pending event count for a session key. */
	async pending(sessionKey: string): Promise<number> {
		return this.store.pending(sessionKey);
	}

	/** Start periodic TTL cleanup. */
	startCleanup(): void {
		if (this.cleanupTimer) return;
		this.cleanupTimer = setInterval(() => {
			void this.store.expireStale();
		}, this.cleanupIntervalMs);
		// Unref so it doesn't prevent Node.js from exiting
		if (this.cleanupTimer.unref) {
			this.cleanupTimer.unref();
		}
	}

	/** Stop periodic TTL cleanup. */
	stopCleanup(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}

	/** Shutdown: stop cleanup and close store. */
	async close(): Promise<void> {
		this.stopCleanup();
		await this.store.close();
	}

	private async sendNotification(sessionKey: string): Promise<void> {
		if (!this.onNotify) return;

		const pendingCount = await this.store.pending(sessionKey);
		if (pendingCount === 0) return;

		this.notificationPending.set(sessionKey, true);

		try {
			await this.onNotify(sessionKey, pendingCount, new Date().toISOString());
		} catch {
			// Notification failure is non-fatal — the drain endpoint still works.
			// Clear the flag so next enqueue retries the notification.
			this.notificationPending.set(sessionKey, false);
		}
	}
}
