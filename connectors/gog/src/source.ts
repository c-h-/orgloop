/**
 * GOG (Gmail) source connector — polls Gmail via gog CLI for email activity.
 *
 * Two polling modes:
 * - History-based (default): uses `gog gmail history --since <historyId>` for incremental changes.
 * - Search-based (when `query` is configured): uses `gog gmail messages search` with dedup.
 *
 * Persists seen-message cache to disk for crash recovery and deduplication.
 */

import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { OrgLoopEvent, PollResult, SourceConfig, SourceConnector } from '@orgloop/sdk';
import { normalizeEmailLabelChanged, normalizeEmailReceived } from './normalizer.js';

const execFile = promisify(execFileCb);

export interface GogSourceConfig {
	account: string;
	query?: string;
	gog_client?: string;
	cache_dir?: string;
	fetch_body?: boolean;
	max_per_poll?: number;
}

/** Parsed message from gog gmail JSON output */
export interface GogMessage {
	id: string;
	threadId: string;
	labelIds?: string[];
	snippet?: string;
	internalDate?: string;
	payload?: {
		headers?: Array<{ name: string; value: string }>;
		body?: { data?: string };
		parts?: Array<{
			mimeType: string;
			body?: { data?: string };
		}>;
	};
}

/** History record from gog gmail history JSON output */
export interface GogHistoryRecord {
	id: string;
	messagesAdded?: Array<{ message: GogMessage }>;
	messagesDeleted?: Array<{ message: { id: string; threadId: string } }>;
	labelsAdded?: Array<{
		message: { id: string; threadId: string };
		labelIds: string[];
	}>;
	labelsRemoved?: Array<{
		message: { id: string; threadId: string };
		labelIds: string[];
	}>;
}

/** Checkpoint stored between polls */
interface GogCheckpoint {
	mode: 'history' | 'search';
	historyId?: string;
	lastPollTimestamp?: string;
}

/** Extract a header value from a Gmail message payload */
function getHeader(message: GogMessage, name: string): string {
	const header = message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase());
	return header?.value ?? '';
}

/** Parse an email address string like "Jane Doe <jane@example.com>" */
function parseEmailAddress(raw: string): { name: string; email: string } {
	const match = raw.match(/^(.+?)\s*<([^>]+)>$/);
	if (match) {
		return { name: match[1].trim().replace(/^"(.*)"$/, '$1'), email: match[2] };
	}
	return { name: '', email: raw.trim() };
}

/** Parse a comma-separated list of email addresses */
function parseEmailList(raw: string): Array<{ name: string; email: string }> {
	if (!raw) return [];
	return raw.split(',').map((s) => parseEmailAddress(s.trim()));
}

/** Decode base64url-encoded content */
function decodeBase64Url(data: string): string {
	const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
	return Buffer.from(base64, 'base64').toString('utf-8');
}

/** Extract plain text body from a Gmail message */
function extractTextBody(message: GogMessage): string | undefined {
	// Check direct body
	if (message.payload?.body?.data) {
		return decodeBase64Url(message.payload.body.data);
	}
	// Check parts
	const textPart = message.payload?.parts?.find((p) => p.mimeType === 'text/plain');
	if (textPart?.body?.data) {
		return decodeBase64Url(textPart.body.data);
	}
	return undefined;
}

/** Extract HTML body from a Gmail message */
function extractHtmlBody(message: GogMessage): string | undefined {
	const htmlPart = message.payload?.parts?.find((p) => p.mimeType === 'text/html');
	if (htmlPart?.body?.data) {
		return decodeBase64Url(htmlPart.body.data);
	}
	return undefined;
}

export class GogSource implements SourceConnector {
	readonly id = 'gog';
	private account!: string;
	private query?: string;
	private client?: string;
	private cacheDir!: string;
	private maxPerPoll = 50;
	private fetchBody = false;
	private seenIds = new Set<string>();
	private sourceId = '';

	async init(config: SourceConfig): Promise<void> {
		const cfg = config.config as unknown as GogSourceConfig;
		this.sourceId = config.id;
		this.account = cfg.account;
		this.query = cfg.query;
		this.client = cfg.gog_client;
		this.maxPerPoll = cfg.max_per_poll ?? 50;
		this.fetchBody = cfg.fetch_body ?? false;
		this.cacheDir = cfg.cache_dir ?? join(tmpdir(), 'orgloop-gog');

		if (!existsSync(this.cacheDir)) {
			mkdirSync(this.cacheDir, { recursive: true });
		}

		this.loadSeenCache();
	}

	async poll(checkpoint: string | null): Promise<PollResult> {
		const cp = this.parseCheckpoint(checkpoint);

		if (this.query) {
			return this.pollSearch(cp);
		}
		return this.pollHistory(cp);
	}

	// ─── History-Based Polling ────────────────────────────────────────────────

	private async pollHistory(cp: GogCheckpoint): Promise<PollResult> {
		const events: OrgLoopEvent[] = [];

		if (!cp.historyId) {
			// Bootstrap: get current profile to obtain latest historyId
			const bootstrapResult = await this.execGog([
				'gmail',
				'messages',
				'search',
				'newer_than:5m',
				'--max',
				String(this.maxPerPoll),
			]);
			const bootstrapMessages = this.parseMessages(bootstrapResult);

			for (const msg of bootstrapMessages) {
				const event = await this.messageToEvent(msg);
				if (event) {
					events.push(event);
					this.seenIds.add(msg.id);
				}
			}

			// We can't call `gog gmail history` without an existing historyId,
			// so bootstrap into search-based mode instead. Subsequent polls
			// will use search with dedup until we obtain a real historyId.
			this.saveSeenCache();
			return {
				events,
				checkpoint: JSON.stringify({ mode: 'search', lastPollTimestamp: new Date().toISOString() } satisfies GogCheckpoint),
			};
		}

		// Incremental history poll
		try {
			const result = await this.execGog([
				'gmail',
				'history',
				'--since',
				cp.historyId,
				'--max',
				String(this.maxPerPoll),
			]);

			const { records, historyId } = this.parseHistoryResult(result);

			for (const record of records) {
				// New messages added
				if (record.messagesAdded) {
					for (const added of record.messagesAdded) {
						if (this.seenIds.has(added.message.id)) continue;

						let msg = added.message;
						if (this.fetchBody || !msg.payload?.headers) {
							const full = await this.fetchMessage(msg.id, this.fetchBody ? 'full' : 'metadata');
							if (full) msg = full;
						}

						const event = await this.messageToEvent(msg);
						if (event) {
							events.push(event);
							this.seenIds.add(msg.id);
						}
					}
				}

				// Label changes
				if (record.labelsAdded || record.labelsRemoved) {
					const labelMessages = new Map<
						string,
						{ id: string; threadId: string; added: string[]; removed: string[] }
					>();

					for (const la of record.labelsAdded ?? []) {
						const existing = labelMessages.get(la.message.id) ?? {
							id: la.message.id,
							threadId: la.message.threadId,
							added: [],
							removed: [],
						};
						existing.added.push(...la.labelIds);
						labelMessages.set(la.message.id, existing);
					}

					for (const lr of record.labelsRemoved ?? []) {
						const existing = labelMessages.get(lr.message.id) ?? {
							id: lr.message.id,
							threadId: lr.message.threadId,
							added: [],
							removed: [],
						};
						existing.removed.push(...lr.labelIds);
						labelMessages.set(lr.message.id, existing);
					}

					for (const entry of labelMessages.values()) {
						events.push(
							normalizeEmailLabelChanged(this.sourceId, {
								id: entry.id,
								threadId: entry.threadId,
								labelsAdded: entry.added,
								labelsRemoved: entry.removed,
							}),
						);
					}
				}
			}

			const newHistoryId = historyId ?? cp.historyId;

			this.saveSeenCache();
			return {
				events,
				checkpoint: JSON.stringify({
					mode: 'history',
					historyId: newHistoryId,
				} satisfies GogCheckpoint),
			};
		} catch (err: unknown) {
			const error = err as { code?: number; stderr?: string; message?: string };

			// historyId expired (404) — reset and bootstrap again
			if (error.stderr?.includes('404') || error.message?.includes('404')) {
				return this.pollHistory({ mode: 'history' });
			}

			return this.handleExecError(err, cp);
		}
	}

	// ─── Search-Based Polling ─────────────────────────────────────────────────

	private async pollSearch(cp: GogCheckpoint): Promise<PollResult> {
		const events: OrgLoopEvent[] = [];

		try {
			const query = this.query ?? '';
			const args = ['gmail', 'messages', 'search', query, '--max', String(this.maxPerPoll)];

			if (this.fetchBody) {
				args.push('--include-body');
			}

			const result = await this.execGog(args);
			const messages = this.parseMessages(result);

			for (const msg of messages) {
				if (this.seenIds.has(msg.id)) continue;

				const event = await this.messageToEvent(msg);
				if (event) {
					events.push(event);
					this.seenIds.add(msg.id);
				}
			}

			this.saveSeenCache();
			return {
				events,
				checkpoint: JSON.stringify({
					mode: 'search',
					lastPollTimestamp: new Date().toISOString(),
				} satisfies GogCheckpoint),
			};
		} catch (err: unknown) {
			return this.handleExecError(err, cp);
		}
	}

	// ─── GOG CLI Execution ──────────────────────────────────────────────────

	async execGog(args: string[]): Promise<unknown> {
		const flags = ['--account', this.account, '--json', '--no-input'];
		if (this.client) flags.push('--client', this.client);

		try {
			const { stdout } = await execFile('gog', [...args, ...flags], {
				timeout: 30_000,
				maxBuffer: 10 * 1024 * 1024,
			});
			return JSON.parse(stdout);
		} catch (err: unknown) {
			const error = err as { code?: number; stderr?: string; stdout?: string };

			// Try to parse partial JSON output
			if (error.stdout) {
				try {
					return JSON.parse(error.stdout);
				} catch {
					// Fall through to throw
				}
			}

			throw err;
		}
	}

	private async fetchMessage(
		messageId: string,
		format: 'full' | 'metadata',
	): Promise<GogMessage | null> {
		try {
			const result = await this.execGog(['gmail', 'get', messageId, '--format', format]);
			return result as GogMessage;
		} catch {
			return null;
		}
	}

	// ─── Result Parsing ─────────────────────────────────────────────────────

	private parseMessages(result: unknown): GogMessage[] {
		if (Array.isArray(result)) return result as GogMessage[];
		if (result && typeof result === 'object' && 'messages' in result) {
			return (result as { messages: GogMessage[] }).messages ?? [];
		}
		return [];
	}

	private parseHistoryResult(result: unknown): {
		records: GogHistoryRecord[];
		historyId: string | undefined;
	} {
		if (Array.isArray(result)) {
			return { records: result as GogHistoryRecord[], historyId: undefined };
		}
		if (result && typeof result === 'object') {
			const obj = result as {
				history?: GogHistoryRecord[];
				historyId?: string;
			};
			return {
				records: obj.history ?? [],
				historyId: obj.historyId,
			};
		}
		return { records: [], historyId: undefined };
	}

	private extractHistoryId(result: unknown): string | undefined {
		if (result && typeof result === 'object') {
			const obj = result as { historyId?: string };
			if (obj.historyId) return obj.historyId;

			// If it's a history list, take the last record's ID
			if (Array.isArray(result) && result.length > 0) {
				const last = result[result.length - 1] as GogHistoryRecord;
				return last.id;
			}

			const withHistory = result as { history?: GogHistoryRecord[] };
			if (withHistory.history?.length) {
				return withHistory.history[withHistory.history.length - 1].id;
			}
		}
		return undefined;
	}

	// ─── Event Building ─────────────────────────────────────────────────────

	private async messageToEvent(msg: GogMessage): Promise<OrgLoopEvent | null> {
		const from = parseEmailAddress(getHeader(msg, 'From'));
		const subject = getHeader(msg, 'Subject');
		const date = getHeader(msg, 'Date') || msg.internalDate || '';

		if (!msg.id || !msg.threadId) return null;

		return normalizeEmailReceived(this.sourceId, {
			id: msg.id,
			threadId: msg.threadId,
			subject,
			from,
			to: parseEmailList(getHeader(msg, 'To')),
			cc: parseEmailList(getHeader(msg, 'Cc')),
			date,
			labels: msg.labelIds ?? [],
			snippet: msg.snippet ?? '',
			...(this.fetchBody ? { body_text: extractTextBody(msg) } : {}),
			...(this.fetchBody ? { body_html: extractHtmlBody(msg) } : {}),
		});
	}

	// ─── Checkpoint Management ──────────────────────────────────────────────

	private parseCheckpoint(raw: string | null): GogCheckpoint {
		if (!raw) {
			return { mode: this.query ? 'search' : 'history' };
		}
		try {
			return JSON.parse(raw) as GogCheckpoint;
		} catch {
			// Legacy or corrupt checkpoint — start fresh
			return { mode: this.query ? 'search' : 'history' };
		}
	}

	// ─── Error Handling ─────────────────────────────────────────────────────

	private handleExecError(err: unknown, cp: GogCheckpoint): PollResult {
		const error = err as { code?: number; stderr?: string; message?: string };

		// Auth errors — return same checkpoint
		if (
			error.stderr?.includes('401') ||
			error.stderr?.includes('403') ||
			error.stderr?.includes('UNAUTHENTICATED') ||
			error.message?.includes('UNAUTHENTICATED')
		) {
			console.error(`[gog] Auth error: ${error.stderr ?? error.message}`);
			return { events: [], checkpoint: JSON.stringify(cp) };
		}

		// Rate limiting — return same checkpoint
		if (
			error.stderr?.includes('429') ||
			error.stderr?.includes('RESOURCE_EXHAUSTED') ||
			error.message?.includes('429')
		) {
			return { events: [], checkpoint: JSON.stringify(cp) };
		}

		throw err;
	}

	// ─── Seen ID Cache ──────────────────────────────────────────────────────

	private get seenCachePath(): string {
		return join(this.cacheDir, `${this.sourceId}-seen-ids.json`);
	}

	private loadSeenCache(): void {
		try {
			if (existsSync(this.seenCachePath)) {
				const raw = readFileSync(this.seenCachePath, 'utf-8');
				const data = JSON.parse(raw) as string[];
				this.seenIds = new Set(data);
			}
		} catch {
			// Corrupt cache — start fresh
			this.seenIds = new Set();
		}
	}

	saveSeenCache(): void {
		try {
			// Keep only the most recent IDs to prevent unbounded growth
			const maxCacheSize = 5000;
			const ids = [...this.seenIds];
			const trimmed = ids.length > maxCacheSize ? ids.slice(-maxCacheSize) : ids;
			writeFileSync(this.seenCachePath, JSON.stringify(trimmed, null, 2));
		} catch {
			console.error('[gog] Failed to persist seen-IDs cache');
		}
	}

	async shutdown(): Promise<void> {
		this.saveSeenCache();
		this.seenIds.clear();
	}
}
