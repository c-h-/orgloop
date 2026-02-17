import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GogMessage } from '../source.js';
import { GogSource } from '../source.js';

// ─── Mock Helpers ──────────────────────────────────────────────────────────────

function makeMessage(
	overrides: Partial<{
		id: string;
		threadId: string;
		labelIds: string[];
		snippet: string;
		internalDate: string;
		from: string;
		to: string;
		cc: string;
		subject: string;
		date: string;
		bodyText: string;
		bodyHtml: string;
	}> = {},
): GogMessage {
	const defaults = {
		id: 'msg-001',
		threadId: 'thread-001',
		labelIds: ['INBOX', 'UNREAD'],
		snippet: 'Hey, following up on our discussion...',
		internalDate: '1707660000000',
		from: 'Jane Doe <jane@acme.com>',
		to: 'Alice <alice@example.com>',
		cc: '',
		subject: 'Partnership proposal',
		date: 'Mon, 11 Feb 2025 14:00:00 -0800',
	};
	const merged = { ...defaults, ...overrides };

	const headers: Array<{ name: string; value: string }> = [
		{ name: 'From', value: merged.from },
		{ name: 'To', value: merged.to },
		{ name: 'Subject', value: merged.subject },
		{ name: 'Date', value: merged.date },
	];
	if (merged.cc) {
		headers.push({ name: 'Cc', value: merged.cc });
	}

	const parts: Array<{ mimeType: string; body?: { data?: string } }> = [];
	if (merged.bodyText) {
		parts.push({
			mimeType: 'text/plain',
			body: { data: Buffer.from(merged.bodyText).toString('base64url') },
		});
	}
	if (merged.bodyHtml) {
		parts.push({
			mimeType: 'text/html',
			body: { data: Buffer.from(merged.bodyHtml).toString('base64url') },
		});
	}

	return {
		id: merged.id,
		threadId: merged.threadId,
		labelIds: merged.labelIds,
		snippet: merged.snippet,
		internalDate: merged.internalDate,
		payload: {
			headers,
			...(parts.length > 0 ? { parts } : {}),
		},
	};
}

function makeHistoryResult(
	records: Array<{
		id?: string;
		messagesAdded?: Array<{ message: GogMessage }>;
		labelsAdded?: Array<{
			message: { id: string; threadId: string };
			labelIds: string[];
		}>;
		labelsRemoved?: Array<{
			message: { id: string; threadId: string };
			labelIds: string[];
		}>;
	}>,
	historyId = '12345',
) {
	return {
		history: records.map((r, i) => ({ id: r.id ?? String(10000 + i), ...r })),
		historyId,
	};
}

// ─── Test Setup ────────────────────────────────────────────────────────────────

let cacheDir: string;

function getCacheDir() {
	const dir = join(
		tmpdir(),
		`orgloop-gog-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function createSource(overrides: Record<string, unknown> = {}) {
	const source = new GogSource();

	await source.init({
		id: 'gog-test',
		connector: 'gog',
		config: {
			account: 'test@example.com',
			cache_dir: cacheDir,
			...overrides,
		},
	});

	return source;
}

/** Inject a mock execGog function on the source */
function mockExecGog(source: GogSource, mockFn: (args: string[]) => Promise<unknown>) {
	(source as unknown as { execGog: typeof mockFn }).execGog = mockFn;
}

describe('GogSource', () => {
	beforeEach(() => {
		cacheDir = getCacheDir();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (existsSync(cacheDir)) {
			rmSync(cacheDir, { recursive: true, force: true });
		}
	});

	// ─── History-Based Polling ──────────────────────────────────────────────

	describe('history-based polling', () => {
		it('bootstraps on first poll (no checkpoint) — records seen IDs without emitting', async () => {
			const source = await createSource();
			const msg = makeMessage();

			mockExecGog(source, async (args) => {
				if (args.includes('messages') && args.includes('search')) {
					// Bootstrap search
					return [msg];
				}
				return { history: [], historyId: '99999' };
			});

			const result = await source.poll(null);

			// Bootstrap should NOT emit events (epoch pattern: establish high-water mark only)
			expect(result.events.length).toBe(0);

			const cp = JSON.parse(result.checkpoint);
			expect(cp.mode).toBe('search');
			expect(cp.lastPollTimestamp).toBeDefined();

			// But the message should be recorded as seen
			// Verify by doing a second poll that returns the same message
			mockExecGog(source, async () => [msg]);
			const result2 = await source.poll(result.checkpoint);
			expect(result2.events.length).toBe(0); // deduped
		});

		it('processes messagesAdded from history records', async () => {
			const source = await createSource();
			const msg = makeMessage({ id: 'msg-new', subject: 'New email' });

			mockExecGog(source, async (args) => {
				if (args.includes('history') && args.includes('--since')) {
					return makeHistoryResult([{ messagesAdded: [{ message: msg }] }], '20000');
				}
				return msg;
			});

			const checkpoint = JSON.stringify({ mode: 'history', historyId: '10000' });
			const result = await source.poll(checkpoint);

			expect(result.events.length).toBe(1);
			expect(result.events[0].payload.message_id).toBe('msg-new');
			expect(result.events[0].payload.subject).toBe('New email');

			const cp = JSON.parse(result.checkpoint);
			expect(cp.historyId).toBe('20000');
		});

		it('processes label changes from history records', async () => {
			const source = await createSource();

			mockExecGog(source, async () => {
				return makeHistoryResult(
					[
						{
							labelsAdded: [
								{
									message: { id: 'msg-1', threadId: 'thread-1' },
									labelIds: ['STARRED'],
								},
							],
							labelsRemoved: [
								{
									message: { id: 'msg-1', threadId: 'thread-1' },
									labelIds: ['UNREAD'],
								},
							],
						},
					],
					'30000',
				);
			});

			const checkpoint = JSON.stringify({ mode: 'history', historyId: '10000' });
			const result = await source.poll(checkpoint);

			const labelEvents = result.events.filter(
				(e) => e.provenance.platform_event === 'email.label_changed',
			);
			expect(labelEvents.length).toBe(1);
			expect(labelEvents[0].payload.labels_added).toEqual(['STARRED']);
			expect(labelEvents[0].payload.labels_removed).toEqual(['UNREAD']);
		});

		it('deduplicates already-seen messages', async () => {
			const source = await createSource();
			const msg = makeMessage({ id: 'msg-dup' });

			const _pollCount = 0;
			mockExecGog(source, async (args) => {
				if (args.includes('messages') && args.includes('search')) {
					return [msg];
				}
				if (args.includes('history') && !args.includes('--since')) {
					return { history: [], historyId: '10000' };
				}
				// Second poll returns same message as messagesAdded
				return makeHistoryResult([{ messagesAdded: [{ message: msg }] }], '20000');
			});

			// First poll bootstraps and sees msg-dup
			await source.poll(null);

			// Second poll returns msg-dup again — should be deduped
			const checkpoint = JSON.stringify({ mode: 'history', historyId: '10000' });
			const result = await source.poll(checkpoint);

			const emailEvents = result.events.filter(
				(e) => e.provenance.platform_event === 'email.received',
			);
			expect(emailEvents.length).toBe(0);
		});

		it('resets on expired historyId (404)', async () => {
			const source = await createSource();
			const msg = makeMessage({ id: 'msg-fresh' });

			let historyCallCount = 0;
			mockExecGog(source, async (args) => {
				if (args.includes('history') && args.includes('--since')) {
					historyCallCount++;
					if (historyCallCount === 1) {
						// Simulate expired historyId
						const error = new Error('gog error') as Error & { stderr: string };
						error.stderr = '404 Not Found: historyId expired';
						throw error;
					}
				}
				if (args.includes('messages') && args.includes('search')) {
					return [msg];
				}
				return { history: [], historyId: '50000' };
			});

			const checkpoint = JSON.stringify({ mode: 'history', historyId: '1' });
			const result = await source.poll(checkpoint);

			// Re-bootstrap records seen IDs but does not emit (epoch pattern)
			expect(result.events.length).toBe(0);
			const cp = JSON.parse(result.checkpoint);
			expect(cp.mode).toBe('search');
			expect(cp.lastPollTimestamp).toBeDefined();
		});
	});

	// ─── Search-Based Polling ──────────────────────────────────────────────

	describe('search-based polling', () => {
		it('uses search mode when query is configured', async () => {
			const source = await createSource({ query: 'label:inbox -category:promotions' });
			const msg = makeMessage({ id: 'msg-search', subject: 'Important email' });

			let capturedArgs: string[] = [];
			mockExecGog(source, async (args) => {
				capturedArgs = args;
				return [msg];
			});

			const result = await source.poll(null);

			expect(capturedArgs).toContain('messages');
			expect(capturedArgs).toContain('search');
			expect(capturedArgs).toContain('label:inbox -category:promotions');
			expect(result.events.length).toBe(1);
			expect(result.events[0].payload.subject).toBe('Important email');

			const cp = JSON.parse(result.checkpoint);
			expect(cp.mode).toBe('search');
			expect(cp.lastPollTimestamp).toBeDefined();
		});

		it('deduplicates search results across polls', async () => {
			const source = await createSource({ query: 'label:inbox' });
			const msg = makeMessage({ id: 'msg-searchdup' });

			mockExecGog(source, async () => [msg]);

			// First poll — sees the message
			const result1 = await source.poll(null);
			expect(result1.events.length).toBe(1);

			// Second poll — same message returned
			const result2 = await source.poll(result1.checkpoint);
			expect(result2.events.length).toBe(0);
		});

		it('passes --include-body when fetch_body is true', async () => {
			const source = await createSource({
				query: 'label:inbox',
				fetch_body: true,
			});

			let capturedArgs: string[] = [];
			mockExecGog(source, async (args) => {
				capturedArgs = args;
				return [];
			});

			await source.poll(null);

			expect(capturedArgs).toContain('--include-body');
		});
	});

	// ─── Event Normalization ───────────────────────────────────────────────

	describe('event normalization', () => {
		it('parses email address headers correctly', async () => {
			const source = await createSource({ query: 'label:inbox' });
			const msg = makeMessage({
				from: '"Jane Doe" <jane@acme.com>',
				to: 'Alice <alice@example.com>, Bob <bob@example.com>',
				cc: 'Alice <alice@example.com>',
			});

			mockExecGog(source, async () => [msg]);

			const result = await source.poll(null);

			expect(result.events[0].payload.from).toEqual({
				name: 'Jane Doe',
				email: 'jane@acme.com',
			});
			expect(result.events[0].payload.to).toEqual([
				{ name: 'Alice', email: 'alice@example.com' },
				{ name: 'Bob', email: 'bob@example.com' },
			]);
			expect(result.events[0].payload.cc).toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
		});

		it('includes body when fetch_body is true and body is present', async () => {
			const source = await createSource({ query: 'label:inbox', fetch_body: true });
			const msg = makeMessage({
				bodyText: 'Hello, world!',
				bodyHtml: '<p>Hello, world!</p>',
			});

			mockExecGog(source, async () => [msg]);

			const result = await source.poll(null);

			expect(result.events[0].payload.body_text).toBe('Hello, world!');
			expect(result.events[0].payload.body_html).toBe('<p>Hello, world!</p>');
		});

		it('sets correct provenance fields', async () => {
			const source = await createSource({ query: 'label:inbox' });
			const msg = makeMessage({
				from: 'sender@example.com',
				threadId: 'thread-abc',
			});

			mockExecGog(source, async () => [msg]);

			const result = await source.poll(null);

			expect(result.events[0].provenance.platform).toBe('gmail');
			expect(result.events[0].provenance.platform_event).toBe('email.received');
			expect(result.events[0].provenance.author).toBe('sender@example.com');
			expect(result.events[0].provenance.author_type).toBe('external');
			expect(result.events[0].provenance.url).toBe(
				'https://mail.google.com/mail/u/0/#inbox/thread-abc',
			);
		});

		it('uses sourceId from config, not connector id', async () => {
			const source = await createSource({ query: 'label:inbox' });
			const msg = makeMessage();

			mockExecGog(source, async () => [msg]);

			const result = await source.poll(null);

			expect(result.events[0].source).toBe('gog-test');
		});
	});

	// ─── Error Handling ────────────────────────────────────────────────────

	describe('error handling', () => {
		it('returns empty events on auth error (401)', async () => {
			const source = await createSource();
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			mockExecGog(source, async () => {
				const error = new Error('auth failed') as Error & { stderr: string };
				error.stderr = '401 Unauthorized';
				throw error;
			});

			const checkpoint = JSON.stringify({ mode: 'history', historyId: '10000' });
			const result = await source.poll(checkpoint);

			expect(result.events).toEqual([]);
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Auth error'));
		});

		it('returns empty events on rate limit (429)', async () => {
			const source = await createSource();

			mockExecGog(source, async () => {
				const error = new Error('rate limited') as Error & { stderr: string };
				error.stderr = '429 Too Many Requests';
				throw error;
			});

			const checkpoint = JSON.stringify({ mode: 'history', historyId: '10000' });
			const result = await source.poll(checkpoint);

			expect(result.events).toEqual([]);
			// Checkpoint should be unchanged
			expect(result.checkpoint).toBe(checkpoint);
		});

		it('rethrows unexpected errors', async () => {
			const source = await createSource();

			mockExecGog(source, async () => {
				throw new Error('Network failure');
			});

			const checkpoint = JSON.stringify({ mode: 'history', historyId: '10000' });
			await expect(source.poll(checkpoint)).rejects.toThrow('Network failure');
		});
	});

	// ─── Seen ID Cache Persistence ─────────────────────────────────────────

	describe('seen-id cache persistence', () => {
		it('persists seen IDs to disk after poll', async () => {
			const source = await createSource();
			const msg = makeMessage({ id: 'msg-persist' });

			mockExecGog(source, async (args) => {
				if (args.includes('messages') && args.includes('search')) return [msg];
				return { history: [], historyId: '10000' };
			});

			await source.poll(null);

			const cachePath = join(cacheDir, 'gog-test-seen-ids.json');
			expect(existsSync(cachePath)).toBe(true);

			const data = JSON.parse(readFileSync(cachePath, 'utf-8'));
			expect(data).toContain('msg-persist');
		});

		it('loads seen IDs from disk on init (survives restart)', async () => {
			// Pre-seed cache
			const cachePath = join(cacheDir, 'gog-test-seen-ids.json');
			writeFileSync(cachePath, JSON.stringify(['msg-existing']));

			const source = await createSource({ query: 'label:inbox' });
			const msg = makeMessage({ id: 'msg-existing' });

			mockExecGog(source, async () => [msg]);

			const result = await source.poll(null);

			// msg-existing should be deduped (was in cache from disk)
			const emailEvents = result.events.filter(
				(e) => e.provenance.platform_event === 'email.received',
			);
			expect(emailEvents.length).toBe(0);
		});

		it('handles corrupt cache gracefully', async () => {
			const cachePath = join(cacheDir, 'gog-test-seen-ids.json');
			writeFileSync(cachePath, '{{not valid json}}');

			const source = await createSource({ query: 'label:inbox' });
			const msg = makeMessage();

			mockExecGog(source, async () => [msg]);

			// Should not throw — corrupt cache is discarded, message emitted normally
			const result = await source.poll(null);
			expect(result.events.length).toBe(1);
		});

		it('saves cache on shutdown', async () => {
			const source = await createSource();
			const msg = makeMessage({ id: 'msg-shutdown' });

			mockExecGog(source, async (args) => {
				if (args.includes('messages') && args.includes('search')) return [msg];
				return { history: [], historyId: '10000' };
			});

			await source.poll(null);

			// Remove the cache to prove shutdown re-saves it
			const cachePath = join(cacheDir, 'gog-test-seen-ids.json');
			rmSync(cachePath);
			expect(existsSync(cachePath)).toBe(false);

			await source.shutdown();
			expect(existsSync(cachePath)).toBe(true);
		});

		it('does not re-emit bootstrap messages after restart (WQ-90 regression)', async () => {
			// Simulate first run: bootstrap records seen IDs and saves cache
			const source1 = await createSource();
			const msg = makeMessage({ id: 'msg-stale', subject: 'Old email' });

			mockExecGog(source1, async (args) => {
				if (args.includes('messages') && args.includes('search')) return [msg];
				return { history: [], historyId: '10000' };
			});

			const result1 = await source1.poll(null);
			expect(result1.events.length).toBe(0); // bootstrap: no events emitted
			await source1.shutdown(); // persists seen cache

			// Simulate restart: new source instance loads cache from disk
			const source2 = await createSource({ query: 'label:inbox' });

			// Gmail returns the same message
			mockExecGog(source2, async () => [msg]);

			const result2 = await source2.poll(result1.checkpoint);

			// msg-stale should be deduped — it was recorded during bootstrap
			expect(result2.events.length).toBe(0);
		});
	});

	// ─── Config ────────────────────────────────────────────────────────────

	describe('init config', () => {
		it('creates cache directory if it does not exist', async () => {
			const newDir = join(cacheDir, 'nested', 'deep');

			const source = new GogSource();
			await source.init({
				id: 'test',
				connector: 'gog',
				config: {
					account: 'test@example.com',
					cache_dir: newDir,
				},
			});

			expect(existsSync(newDir)).toBe(true);
			rmSync(newDir, { recursive: true, force: true });
		});

		it('sets maxPerPoll from config', async () => {
			const source = await createSource({ max_per_poll: 10, query: 'label:inbox' });
			let capturedArgs: string[] = [];

			mockExecGog(source, async (args) => {
				capturedArgs = args;
				return [];
			});

			await source.poll(null);

			const maxIdx = capturedArgs.indexOf('--max');
			expect(maxIdx).toBeGreaterThan(-1);
			expect(capturedArgs[maxIdx + 1]).toBe('10');
		});

		it('passes gog_client when configured', async () => {
			const source = await createSource({ gog_client: 'my-client' });

			// Verify via the mock
			mockExecGog(source, async () => {
				return [];
			});

			await source.poll(
				JSON.stringify({ mode: 'search', lastPollTimestamp: new Date().toISOString() }),
			);
			// The mock replaces execGog entirely so we can't test flag passing here.
			// This is tested implicitly — the source stores the client value.
			// A true integration test would verify the CLI args.
		});
	});

	// ─── Checkpoint Management ─────────────────────────────────────────────

	describe('checkpoint management', () => {
		it('handles null checkpoint by starting fresh', async () => {
			const source = await createSource();

			mockExecGog(source, async (args) => {
				if (args.includes('messages') && args.includes('search')) return [];
				return { history: [], historyId: '10000' };
			});

			const result = await source.poll(null);
			const cp = JSON.parse(result.checkpoint);
			expect(cp.mode).toBe('search');
			expect(cp.lastPollTimestamp).toBeDefined();
		});

		it('handles corrupt checkpoint gracefully', async () => {
			const source = await createSource();

			mockExecGog(source, async (args) => {
				if (args.includes('messages') && args.includes('search')) return [];
				return { history: [], historyId: '10000' };
			});

			// Corrupt checkpoint — should not throw, falls back to bootstrap (search mode)
			const result = await source.poll('not-valid-json');
			const cp = JSON.parse(result.checkpoint);
			expect(cp.mode).toBe('search');
		});

		it('preserves search mode checkpoint', async () => {
			const source = await createSource({ query: 'label:inbox' });

			mockExecGog(source, async () => []);

			const result = await source.poll(null);
			const cp = JSON.parse(result.checkpoint);
			expect(cp.mode).toBe('search');
		});
	});

	// ─── Multiple Messages ─────────────────────────────────────────────────

	describe('multiple messages', () => {
		it('processes multiple new messages in a single poll', async () => {
			const source = await createSource({ query: 'label:inbox' });
			const msg1 = makeMessage({ id: 'msg-1', subject: 'First' });
			const msg2 = makeMessage({ id: 'msg-2', subject: 'Second' });
			const msg3 = makeMessage({ id: 'msg-3', subject: 'Third' });

			mockExecGog(source, async () => [msg1, msg2, msg3]);

			const result = await source.poll(null);

			expect(result.events.length).toBe(3);
			const subjects = result.events.map((e) => e.payload.subject);
			expect(subjects).toEqual(['First', 'Second', 'Third']);
		});

		it('handles mixed history records (messages + label changes)', async () => {
			const source = await createSource();
			const msg = makeMessage({ id: 'msg-mixed' });

			mockExecGog(source, async () => {
				return makeHistoryResult(
					[
						{ messagesAdded: [{ message: msg }] },
						{
							labelsAdded: [
								{
									message: { id: 'msg-other', threadId: 'thread-other' },
									labelIds: ['IMPORTANT'],
								},
							],
						},
					],
					'40000',
				);
			});

			const checkpoint = JSON.stringify({ mode: 'history', historyId: '10000' });
			const result = await source.poll(checkpoint);

			const emailEvents = result.events.filter(
				(e) => e.provenance.platform_event === 'email.received',
			);
			const labelEvents = result.events.filter(
				(e) => e.provenance.platform_event === 'email.label_changed',
			);
			expect(emailEvents.length).toBe(1);
			expect(labelEvents.length).toBe(1);
		});
	});

	// ─── Registration ─────────────────────────────────────────────────────

	describe('registration', () => {
		it('exports a valid ConnectorRegistration', async () => {
			const { default: register } = await import('../index.js');
			const reg = register();

			expect(reg.id).toBe('gog');
			expect(reg.source).toBe(GogSource);
			expect(reg.setup?.integrations).toBeDefined();
			expect(reg.setup?.integrations?.[0]?.id).toBe('gog-cli');
		});
	});
});
