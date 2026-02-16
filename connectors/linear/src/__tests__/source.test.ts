import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CachedIssueState } from '../source.js';
import { LinearSource } from '../source.js';

// ─── Mock Helpers ──────────────────────────────────────────────────────────────

function makeIssueNode(
	overrides: Partial<{
		id: string;
		identifier: string;
		title: string;
		description: string;
		url: string;
		priority: number;
		createdAt: Date;
		updatedAt: Date;
		state: { name: string } | null;
		assignee: { name: string } | null;
		creator: { name: string } | null;
		labels: Array<{ name: string }>;
		comments: Array<{
			id: string;
			body: string;
			url: string;
			createdAt: Date;
			user: { name: string } | null;
		}>;
	}> = {},
) {
	const defaults = {
		id: 'issue-1',
		identifier: 'ENG-1',
		title: 'Test Issue',
		description: 'A test issue',
		url: 'https://linear.app/team/ENG-1',
		priority: 2,
		createdAt: new Date('2024-01-01T12:00:00Z'),
		updatedAt: new Date('2024-01-01T12:05:00Z'),
		state: { name: 'In Progress' },
		assignee: { name: 'Alice' },
		creator: { name: 'Bob' },
		labels: [{ name: 'bug' }],
		comments: [],
	};
	const merged = { ...defaults, ...overrides };
	return {
		id: merged.id,
		identifier: merged.identifier,
		title: merged.title,
		description: merged.description,
		url: merged.url,
		priority: merged.priority,
		createdAt: merged.createdAt,
		updatedAt: merged.updatedAt,
		// These return promises to mimic @linear/sdk lazy resolution
		state: Promise.resolve(merged.state),
		assignee: Promise.resolve(merged.assignee),
		creator: Promise.resolve(merged.creator),
		labels: () =>
			Promise.resolve({
				nodes: merged.labels,
			}),
		comments: () =>
			Promise.resolve({
				nodes: merged.comments.map((c) => ({
					...c,
					user: Promise.resolve(c.user),
				})),
			}),
	};
}

function makeIssueConnection(
	nodes: ReturnType<typeof makeIssueNode>[],
	hasNextPage = false,
	endCursor?: string,
) {
	return {
		nodes,
		pageInfo: { hasNextPage, endCursor },
	};
}

function makeMockClient(teamIssues: ReturnType<typeof makeIssueConnection>) {
	return {
		team: vi.fn().mockResolvedValue({
			issues: vi.fn().mockResolvedValue(teamIssues),
		}),
		comments: vi.fn().mockResolvedValue({ nodes: [] }),
	};
}

// ─── Test Setup ────────────────────────────────────────────────────────────────

let cacheDir: string;

function getCacheDir() {
	const dir = join(
		tmpdir(),
		`orgloop-linear-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function createSource(
	mockClient: ReturnType<typeof makeMockClient>,
	overrides: Record<string, unknown> = {},
) {
	const source = new LinearSource();
	// Stub env var
	vi.stubEnv('LINEAR_API_KEY', 'test-api-key');

	await source.init({
		id: 'linear-test',
		connector: 'linear',
		config: {
			team: 'ENG',
			api_key: '${LINEAR_API_KEY}',
			cache_dir: cacheDir,
			...overrides,
		},
	});

	// Replace client with mock
	(source as unknown as { client: unknown }).client = mockClient;
	return source;
}

describe('LinearSource', () => {
	beforeEach(() => {
		cacheDir = getCacheDir();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		if (existsSync(cacheDir)) {
			rmSync(cacheDir, { recursive: true, force: true });
		}
	});

	// ─── New Issue Detection ──────────────────────────────────────────────────

	describe('new issue detection', () => {
		it('emits issue.created for issues created after checkpoint', async () => {
			const issue = makeIssueNode({
				createdAt: new Date('2024-01-01T12:02:00Z'),
				updatedAt: new Date('2024-01-01T12:02:00Z'),
			});
			const conn = makeIssueConnection([issue]);
			const source = await createSource(makeMockClient(conn));

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			expect(result.events.length).toBe(1);
			expect(result.events[0].provenance.platform_event).toBe('issue.created');
			expect(result.events[0].payload.action).toBe('issue_created');
		});

		it('does not emit for issues created before checkpoint', async () => {
			const issue = makeIssueNode({
				createdAt: new Date('2024-01-01T11:00:00Z'),
				updatedAt: new Date('2024-01-01T12:02:00Z'),
			});
			const conn = makeIssueConnection([issue]);
			const source = await createSource(makeMockClient(conn));

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			// No events since this is the first time we see it but it's old
			expect(result.events.length).toBe(0);
		});
	});

	// ─── State Change Detection ──────────────────────────────────────────────

	describe('state change detection', () => {
		it('emits state_changed when issue state changes between polls', async () => {
			const issue1 = makeIssueNode({
				state: { name: 'Todo' },
				createdAt: new Date('2024-01-01T12:01:00Z'),
			});
			const conn1 = makeIssueConnection([issue1]);
			const client = makeMockClient(conn1);
			const source = await createSource(client);

			// First poll — seeds cache, emits issue.created
			await source.poll('2024-01-01T12:00:00.000Z');

			// Second poll — state changed to In Progress
			const issue2 = makeIssueNode({
				state: { name: 'In Progress' },
				updatedAt: new Date('2024-01-01T12:10:00Z'),
			});
			const conn2 = makeIssueConnection([issue2]);
			const team2 = { issues: vi.fn().mockResolvedValue(conn2) };
			client.team.mockResolvedValue(team2);

			const result = await source.poll('2024-01-01T12:05:00.000Z');

			const stateChanges = result.events.filter(
				(e) => e.provenance.platform_event === 'issue.state_changed',
			);
			expect(stateChanges.length).toBe(1);
			expect(stateChanges[0].payload.previous_state).toBe('Todo');
			expect(stateChanges[0].payload.new_state).toBe('In Progress');
		});

		it('does not emit when state is unchanged', async () => {
			const issue = makeIssueNode({
				state: { name: 'In Progress' },
				createdAt: new Date('2024-01-01T12:01:00Z'),
			});
			const conn = makeIssueConnection([issue]);
			const client = makeMockClient(conn);
			const source = await createSource(client);

			// First poll — seeds cache
			await source.poll('2024-01-01T12:00:00.000Z');

			// Second poll — same state
			const issue2 = makeIssueNode({
				state: { name: 'In Progress' },
				updatedAt: new Date('2024-01-01T12:10:00Z'),
			});
			const conn2 = makeIssueConnection([issue2]);
			const team2 = { issues: vi.fn().mockResolvedValue(conn2) };
			client.team.mockResolvedValue(team2);

			const result = await source.poll('2024-01-01T12:05:00.000Z');

			const stateChanges = result.events.filter(
				(e) => e.provenance.platform_event === 'issue.state_changed',
			);
			expect(stateChanges.length).toBe(0);
		});
	});

	// ─── Assignee Change Detection ──────────────────────────────────────────

	describe('assignee change detection', () => {
		it('emits assignee_changed when assignee changes', async () => {
			const issue1 = makeIssueNode({
				assignee: { name: 'Alice' },
				createdAt: new Date('2024-01-01T12:01:00Z'),
			});
			const conn1 = makeIssueConnection([issue1]);
			const client = makeMockClient(conn1);
			const source = await createSource(client);

			await source.poll('2024-01-01T12:00:00.000Z');

			// Reassign to Bob
			const issue2 = makeIssueNode({
				assignee: { name: 'Bob' },
				updatedAt: new Date('2024-01-01T12:10:00Z'),
			});
			const conn2 = makeIssueConnection([issue2]);
			client.team.mockResolvedValue({ issues: vi.fn().mockResolvedValue(conn2) });

			const result = await source.poll('2024-01-01T12:05:00.000Z');

			const assigneeChanges = result.events.filter(
				(e) => e.provenance.platform_event === 'issue.assignee_changed',
			);
			expect(assigneeChanges.length).toBe(1);
			expect(assigneeChanges[0].payload.previous_assignee).toBe('Alice');
			expect(assigneeChanges[0].payload.new_assignee).toBe('Bob');
		});

		it('emits assignee_changed when unassigned', async () => {
			const issue1 = makeIssueNode({
				assignee: { name: 'Alice' },
				createdAt: new Date('2024-01-01T12:01:00Z'),
			});
			const conn1 = makeIssueConnection([issue1]);
			const client = makeMockClient(conn1);
			const source = await createSource(client);

			await source.poll('2024-01-01T12:00:00.000Z');

			// Unassign
			const issue2 = makeIssueNode({
				assignee: null,
				updatedAt: new Date('2024-01-01T12:10:00Z'),
			});
			const conn2 = makeIssueConnection([issue2]);
			client.team.mockResolvedValue({ issues: vi.fn().mockResolvedValue(conn2) });

			const result = await source.poll('2024-01-01T12:05:00.000Z');

			const assigneeChanges = result.events.filter(
				(e) => e.provenance.platform_event === 'issue.assignee_changed',
			);
			expect(assigneeChanges.length).toBe(1);
			expect(assigneeChanges[0].payload.previous_assignee).toBe('Alice');
			expect(assigneeChanges[0].payload.new_assignee).toBe(null);
		});
	});

	// ─── Priority Change Detection ──────────────────────────────────────────

	describe('priority change detection', () => {
		it('emits priority_changed when priority changes', async () => {
			const issue1 = makeIssueNode({
				priority: 2,
				createdAt: new Date('2024-01-01T12:01:00Z'),
			});
			const conn1 = makeIssueConnection([issue1]);
			const client = makeMockClient(conn1);
			const source = await createSource(client);

			await source.poll('2024-01-01T12:00:00.000Z');

			// Escalate priority
			const issue2 = makeIssueNode({
				priority: 1,
				updatedAt: new Date('2024-01-01T12:10:00Z'),
			});
			const conn2 = makeIssueConnection([issue2]);
			client.team.mockResolvedValue({ issues: vi.fn().mockResolvedValue(conn2) });

			const result = await source.poll('2024-01-01T12:05:00.000Z');

			const priorityChanges = result.events.filter(
				(e) => e.provenance.platform_event === 'issue.priority_changed',
			);
			expect(priorityChanges.length).toBe(1);
			expect(priorityChanges[0].payload.previous_priority).toBe(2);
			expect(priorityChanges[0].payload.new_priority).toBe(1);
		});
	});

	// ─── Label Change Detection ─────────────────────────────────────────────

	describe('label change detection', () => {
		it('emits labels_changed when labels change', async () => {
			const issue1 = makeIssueNode({
				labels: [{ name: 'bug' }],
				createdAt: new Date('2024-01-01T12:01:00Z'),
			});
			const conn1 = makeIssueConnection([issue1]);
			const client = makeMockClient(conn1);
			const source = await createSource(client);

			await source.poll('2024-01-01T12:00:00.000Z');

			// Add 'urgent' label
			const issue2 = makeIssueNode({
				labels: [{ name: 'bug' }, { name: 'urgent' }],
				updatedAt: new Date('2024-01-01T12:10:00Z'),
			});
			const conn2 = makeIssueConnection([issue2]);
			client.team.mockResolvedValue({ issues: vi.fn().mockResolvedValue(conn2) });

			const result = await source.poll('2024-01-01T12:05:00.000Z');

			const labelChanges = result.events.filter(
				(e) => e.provenance.platform_event === 'issue.labels_changed',
			);
			expect(labelChanges.length).toBe(1);
			expect(labelChanges[0].payload.added_labels).toEqual(['urgent']);
			expect(labelChanges[0].payload.removed_labels).toEqual([]);
		});

		it('detects removed labels', async () => {
			const issue1 = makeIssueNode({
				labels: [{ name: 'bug' }, { name: 'urgent' }],
				createdAt: new Date('2024-01-01T12:01:00Z'),
			});
			const conn1 = makeIssueConnection([issue1]);
			const client = makeMockClient(conn1);
			const source = await createSource(client);

			await source.poll('2024-01-01T12:00:00.000Z');

			// Remove 'urgent' label
			const issue2 = makeIssueNode({
				labels: [{ name: 'bug' }],
				updatedAt: new Date('2024-01-01T12:10:00Z'),
			});
			const conn2 = makeIssueConnection([issue2]);
			client.team.mockResolvedValue({ issues: vi.fn().mockResolvedValue(conn2) });

			const result = await source.poll('2024-01-01T12:05:00.000Z');

			const labelChanges = result.events.filter(
				(e) => e.provenance.platform_event === 'issue.labels_changed',
			);
			expect(labelChanges.length).toBe(1);
			expect(labelChanges[0].payload.removed_labels).toEqual(['urgent']);
			expect(labelChanges[0].payload.added_labels).toEqual([]);
		});
	});

	// ─── Comment Polling ────────────────────────────────────────────────────

	describe('comment polling', () => {
		it('emits comment.created for new comments on team issues', async () => {
			const issue = makeIssueNode({
				createdAt: new Date('2024-01-01T11:00:00Z'),
				updatedAt: new Date('2024-01-01T12:05:00Z'),
				comments: [
					{
						id: 'comment-1',
						body: 'Looks good',
						url: 'https://linear.app/comment/1',
						createdAt: new Date('2024-01-01T12:02:00Z'),
						user: { name: 'Alice' },
					},
				],
			});
			const conn = makeIssueConnection([issue]);
			const client = makeMockClient(conn);
			const source = await createSource(client);

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			const comments = result.events.filter(
				(e) => e.provenance.platform_event === 'comment.created',
			);
			expect(comments.length).toBe(1);
			expect(comments[0].payload.comment_body).toBe('Looks good');
			expect(comments[0].payload.issue_id).toBe('ENG-1');
		});
	});

	// ─── State Cache Persistence ────────────────────────────────────────────

	describe('state cache persistence', () => {
		it('persists state cache to disk after poll', async () => {
			const issue = makeIssueNode({
				createdAt: new Date('2024-01-01T12:01:00Z'),
			});
			const conn = makeIssueConnection([issue]);
			const source = await createSource(makeMockClient(conn));

			await source.poll('2024-01-01T12:00:00.000Z');

			const cachePath = join(cacheDir, 'linear-test-state-cache.json');
			expect(existsSync(cachePath)).toBe(true);

			const data = JSON.parse(readFileSync(cachePath, 'utf-8'));
			expect(data['issue-1']).toBeDefined();
			expect(data['issue-1'].state).toBe('In Progress');
			expect(data['issue-1'].assignee).toBe('Alice');
			expect(data['issue-1'].priority).toBe(2);
			expect(data['issue-1'].labels).toEqual(['bug']);
		});

		it('loads state cache from disk on init (survives restart)', async () => {
			// Pre-seed a cache file
			const cachePath = join(cacheDir, 'linear-test-state-cache.json');
			const seeded: Record<string, CachedIssueState> = {
				'issue-1': {
					state: 'Todo',
					assignee: 'Alice',
					priority: 2,
					labels: ['bug'],
				},
			};
			writeFileSync(cachePath, JSON.stringify(seeded));

			// The issue is now In Progress — should detect state change
			const issue = makeIssueNode({
				state: { name: 'In Progress' },
				createdAt: new Date('2024-01-01T11:00:00Z'),
				updatedAt: new Date('2024-01-01T12:05:00Z'),
			});
			const conn = makeIssueConnection([issue]);
			const source = await createSource(makeMockClient(conn));

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			const stateChanges = result.events.filter(
				(e) => e.provenance.platform_event === 'issue.state_changed',
			);
			expect(stateChanges.length).toBe(1);
			expect(stateChanges[0].payload.previous_state).toBe('Todo');
			expect(stateChanges[0].payload.new_state).toBe('In Progress');
		});

		it('handles corrupt cache gracefully', async () => {
			const cachePath = join(cacheDir, 'linear-test-state-cache.json');
			writeFileSync(cachePath, '{{not valid json}}');

			const issue = makeIssueNode({
				createdAt: new Date('2024-01-01T12:01:00Z'),
			});
			const conn = makeIssueConnection([issue]);
			const source = await createSource(makeMockClient(conn));

			// Should not throw
			const result = await source.poll('2024-01-01T12:00:00.000Z');
			expect(result.events.length).toBe(1); // new issue detected
		});

		it('saves state cache on shutdown', async () => {
			const issue = makeIssueNode({
				createdAt: new Date('2024-01-01T12:01:00Z'),
			});
			const conn = makeIssueConnection([issue]);
			const source = await createSource(makeMockClient(conn));

			await source.poll('2024-01-01T12:00:00.000Z');

			// Remove the cache file to prove shutdown re-saves it
			const cachePath = join(cacheDir, 'linear-test-state-cache.json');
			rmSync(cachePath);
			expect(existsSync(cachePath)).toBe(false);

			await source.shutdown();
			expect(existsSync(cachePath)).toBe(true);
		});
	});

	// ─── Pagination ─────────────────────────────────────────────────────────

	describe('pagination', () => {
		it('follows cursor-based pagination', async () => {
			const issue1 = makeIssueNode({
				id: 'issue-1',
				identifier: 'ENG-1',
				createdAt: new Date('2024-01-01T12:01:00Z'),
			});
			const issue2 = makeIssueNode({
				id: 'issue-2',
				identifier: 'ENG-2',
				createdAt: new Date('2024-01-01T12:02:00Z'),
			});

			const page1 = makeIssueConnection([issue1], true, 'cursor-1');
			const page2 = makeIssueConnection([issue2], false);
			const emptyConn = makeIssueConnection([]);

			// Track issue poll calls vs comment poll calls
			let issueCallCount = 0;
			const issuesFn = vi.fn().mockImplementation((_opts: { after?: string }) => {
				// pollComments also calls team.issues — return empty for that
				issueCallCount++;
				if (issueCallCount === 1) return page1;
				if (issueCallCount === 2) return page2;
				return emptyConn;
			});

			const client = {
				team: vi.fn().mockResolvedValue({ issues: issuesFn }),
				comments: vi.fn().mockResolvedValue({ nodes: [] }),
			};

			const source = await createSource(client);
			const result = await source.poll('2024-01-01T12:00:00.000Z');

			// Should have paginated — both issues detected
			const newIssues = result.events.filter(
				(e) => e.provenance.platform_event === 'issue.created',
			);
			expect(newIssues.length).toBe(2);
			// Issue polling: first call has no cursor, second has cursor-1
			expect(issuesFn.mock.calls[0][0].after).toBeUndefined();
			expect(issuesFn.mock.calls[1][0].after).toBe('cursor-1');
		});
	});

	// ─── Rate Limiting ──────────────────────────────────────────────────────

	describe('rate limiting', () => {
		it('returns empty events on rate limit (429)', async () => {
			const client = {
				team: vi.fn().mockRejectedValue({ status: 429, message: 'Rate limited' }),
				comments: vi.fn(),
			};
			const source = await createSource(client);

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			expect(result.events).toEqual([]);
			expect(result.checkpoint).toBe('2024-01-01T12:00:00.000Z');
		});

		it('returns empty events on RATE_LIMITED GraphQL extension', async () => {
			const client = {
				team: vi.fn().mockRejectedValue({
					extensions: { code: 'RATE_LIMITED' },
					message: 'Rate limited',
				}),
				comments: vi.fn(),
			};
			const source = await createSource(client);

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			expect(result.events).toEqual([]);
		});
	});

	// ─── Auth Error Handling ────────────────────────────────────────────────

	describe('auth error handling', () => {
		it('returns empty events on 401', async () => {
			const client = {
				team: vi.fn().mockRejectedValue({ status: 401, message: 'Unauthorized' }),
				comments: vi.fn(),
			};
			const source = await createSource(client);
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			expect(result.events).toEqual([]);
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Auth error'));
		});

		it('returns empty events on 403', async () => {
			const client = {
				team: vi.fn().mockRejectedValue({ status: 403, message: 'Forbidden' }),
				comments: vi.fn(),
			};
			const source = await createSource(client);
			vi.spyOn(console, 'error').mockImplementation(() => {});

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			expect(result.events).toEqual([]);
		});

		it('rethrows unexpected errors', async () => {
			const client = {
				team: vi.fn().mockRejectedValue(new Error('Network failure')),
				comments: vi.fn(),
			};
			const source = await createSource(client);

			await expect(source.poll('2024-01-01T12:00:00.000Z')).rejects.toThrow('Network failure');
		});
	});

	// ─── Checkpoint Advancement ──────────────────────────────────────────────

	describe('checkpoint advancement', () => {
		it('advances checkpoint to latest event timestamp', async () => {
			const issue = makeIssueNode({
				createdAt: new Date('2024-01-01T12:05:00Z'),
				updatedAt: new Date('2024-01-01T12:05:00Z'),
			});
			const conn = makeIssueConnection([issue]);
			const source = await createSource(makeMockClient(conn));

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			// Checkpoint should be the event's timestamp, not the original since
			expect(result.checkpoint > '2024-01-01T12:00:00.000Z').toBe(true);
		});

		it('uses default 5-minute lookback when no checkpoint', async () => {
			const conn = makeIssueConnection([]);
			const client = makeMockClient(conn);
			const source = await createSource(client);

			const before = Date.now();
			const result = await source.poll(null);

			// Checkpoint should be roughly 5 minutes ago
			const cpTime = new Date(result.checkpoint).getTime();
			expect(cpTime).toBeGreaterThan(before - 6 * 60 * 1000);
			expect(cpTime).toBeLessThanOrEqual(before);
		});
	});

	// ─── Multiple Changes in One Poll ────────────────────────────────────────

	describe('multiple changes in one poll', () => {
		it('detects state + assignee + priority + label changes simultaneously', async () => {
			// Seed cache
			const cachePath = join(cacheDir, 'linear-test-state-cache.json');
			const seeded: Record<string, CachedIssueState> = {
				'issue-1': {
					state: 'Todo',
					assignee: 'Alice',
					priority: 3,
					labels: ['feature'],
				},
			};
			writeFileSync(cachePath, JSON.stringify(seeded));

			// Everything changed
			const issue = makeIssueNode({
				state: { name: 'Done' },
				assignee: { name: 'Bob' },
				priority: 1,
				labels: [{ name: 'bug' }, { name: 'urgent' }],
				createdAt: new Date('2024-01-01T11:00:00Z'),
				updatedAt: new Date('2024-01-01T12:05:00Z'),
			});
			const conn = makeIssueConnection([issue]);
			const source = await createSource(makeMockClient(conn));

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			const eventTypes = result.events.map((e) => e.provenance.platform_event).sort();
			expect(eventTypes).toEqual([
				'issue.assignee_changed',
				'issue.labels_changed',
				'issue.priority_changed',
				'issue.state_changed',
			]);
		});
	});

	// ─── Init Config ────────────────────────────────────────────────────────

	describe('init config', () => {
		it('resolves env vars in api_key', async () => {
			vi.stubEnv('LINEAR_API_KEY', 'lin_test_123');

			const source = new LinearSource();
			// Should not throw
			await source.init({
				id: 'test',
				connector: 'linear',
				config: {
					team: 'ENG',
					api_key: '${LINEAR_API_KEY}',
					cache_dir: cacheDir,
				},
			});
		});

		it('throws when env var is missing', async () => {
			vi.stubEnv('LINEAR_API_KEY', '');
			process.env.LINEAR_API_KEY = undefined;

			const source = new LinearSource();
			await expect(
				source.init({
					id: 'test',
					connector: 'linear',
					config: {
						team: 'ENG',
						api_key: '${MISSING_VAR}',
						cache_dir: cacheDir,
					},
				}),
			).rejects.toThrow('MISSING_VAR is not set');
		});

		it('creates cache directory if it does not exist', async () => {
			const newDir = join(cacheDir, 'nested', 'deep');
			vi.stubEnv('LINEAR_API_KEY', 'test-key');

			const source = new LinearSource();
			await source.init({
				id: 'test',
				connector: 'linear',
				config: {
					team: 'ENG',
					api_key: '${LINEAR_API_KEY}',
					cache_dir: newDir,
				},
			});

			expect(existsSync(newDir)).toBe(true);
			// Cleanup
			rmSync(newDir, { recursive: true, force: true });
		});
	});
});
