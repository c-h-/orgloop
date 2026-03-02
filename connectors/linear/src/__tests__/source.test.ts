import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchIssueNode, BatchIssuesResponse } from '../graphql.js';
import type { CachedIssueState } from '../source.js';
import { LinearSource } from '../source.js';

// ─── Mock the graphql module ────────────────────────────────────────────────

vi.mock('../graphql.js', () => ({
	executeBatchQuery: vi.fn(),
}));

import { executeBatchQuery } from '../graphql.js';

const mockExecuteBatchQuery = vi.mocked(executeBatchQuery);

// ─── Mock Helpers ──────────────────────────────────────────────────────────────

function makeIssueNode(
	overrides: Partial<{
		id: string;
		identifier: string;
		title: string;
		description: string | null;
		url: string;
		priority: number;
		createdAt: string;
		updatedAt: string;
		state: { name: string } | null;
		assignee: { name: string } | null;
		creator: { name: string } | null;
		labels: Array<{ name: string }>;
		comments: Array<{
			id: string;
			body: string;
			url: string;
			createdAt: string;
			user: { name: string } | null;
		}>;
	}> = {},
): BatchIssueNode {
	const defaults = {
		id: 'issue-1',
		identifier: 'ENG-1',
		title: 'Test Issue',
		description: 'A test issue',
		url: 'https://linear.app/team/ENG-1',
		priority: 2,
		createdAt: '2024-01-01T12:00:00.000Z',
		updatedAt: '2024-01-01T12:05:00.000Z',
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
		state: merged.state,
		assignee: merged.assignee,
		creator: merged.creator,
		labels: { nodes: merged.labels },
		comments: { nodes: merged.comments },
	};
}

function makeBatchResponse(
	nodes: BatchIssueNode[],
	hasNextPage = false,
	endCursor?: string,
): BatchIssuesResponse {
	return {
		team: {
			issues: {
				nodes,
				pageInfo: { hasNextPage, endCursor: endCursor ?? null },
			},
		},
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

async function createSource(overrides: Record<string, unknown> = {}) {
	const source = new LinearSource();
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

	return source;
}

describe('LinearSource', () => {
	beforeEach(() => {
		cacheDir = getCacheDir();
		mockExecuteBatchQuery.mockReset();
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
				createdAt: '2024-01-01T12:02:00.000Z',
				updatedAt: '2024-01-01T12:02:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValue(makeBatchResponse([issue]));
			const source = await createSource();

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			expect(result.events.length).toBe(1);
			expect(result.events[0].provenance.platform_event).toBe('issue.created');
			expect(result.events[0].payload.action).toBe('issue_created');
		});

		it('does not emit for issues created before checkpoint', async () => {
			const issue = makeIssueNode({
				createdAt: '2024-01-01T11:00:00.000Z',
				updatedAt: '2024-01-01T12:02:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValue(makeBatchResponse([issue]));
			const source = await createSource();

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			expect(result.events.length).toBe(0);
		});
	});

	// ─── State Change Detection ──────────────────────────────────────────────

	describe('state change detection', () => {
		it('emits state_changed when issue state changes between polls', async () => {
			const issue1 = makeIssueNode({
				state: { name: 'Todo' },
				createdAt: '2024-01-01T12:01:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValueOnce(makeBatchResponse([issue1]));
			const source = await createSource();

			// First poll — seeds cache, emits issue.created
			await source.poll('2024-01-01T12:00:00.000Z');

			// Second poll — state changed to In Progress
			const issue2 = makeIssueNode({
				state: { name: 'In Progress' },
				updatedAt: '2024-01-01T12:10:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValueOnce(makeBatchResponse([issue2]));

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
				createdAt: '2024-01-01T12:01:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValueOnce(makeBatchResponse([issue]));
			const source = await createSource();

			await source.poll('2024-01-01T12:00:00.000Z');

			const issue2 = makeIssueNode({
				state: { name: 'In Progress' },
				updatedAt: '2024-01-01T12:10:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValueOnce(makeBatchResponse([issue2]));

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
				createdAt: '2024-01-01T12:01:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValueOnce(makeBatchResponse([issue1]));
			const source = await createSource();

			await source.poll('2024-01-01T12:00:00.000Z');

			const issue2 = makeIssueNode({
				assignee: { name: 'Bob' },
				updatedAt: '2024-01-01T12:10:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValueOnce(makeBatchResponse([issue2]));

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
				createdAt: '2024-01-01T12:01:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValueOnce(makeBatchResponse([issue1]));
			const source = await createSource();

			await source.poll('2024-01-01T12:00:00.000Z');

			const issue2 = makeIssueNode({
				assignee: null,
				updatedAt: '2024-01-01T12:10:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValueOnce(makeBatchResponse([issue2]));

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
				createdAt: '2024-01-01T12:01:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValueOnce(makeBatchResponse([issue1]));
			const source = await createSource();

			await source.poll('2024-01-01T12:00:00.000Z');

			const issue2 = makeIssueNode({
				priority: 1,
				updatedAt: '2024-01-01T12:10:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValueOnce(makeBatchResponse([issue2]));

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
				createdAt: '2024-01-01T12:01:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValueOnce(makeBatchResponse([issue1]));
			const source = await createSource();

			await source.poll('2024-01-01T12:00:00.000Z');

			const issue2 = makeIssueNode({
				labels: [{ name: 'bug' }, { name: 'urgent' }],
				updatedAt: '2024-01-01T12:10:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValueOnce(makeBatchResponse([issue2]));

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
				createdAt: '2024-01-01T12:01:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValueOnce(makeBatchResponse([issue1]));
			const source = await createSource();

			await source.poll('2024-01-01T12:00:00.000Z');

			const issue2 = makeIssueNode({
				labels: [{ name: 'bug' }],
				updatedAt: '2024-01-01T12:10:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValueOnce(makeBatchResponse([issue2]));

			const result = await source.poll('2024-01-01T12:05:00.000Z');

			const labelChanges = result.events.filter(
				(e) => e.provenance.platform_event === 'issue.labels_changed',
			);
			expect(labelChanges.length).toBe(1);
			expect(labelChanges[0].payload.removed_labels).toEqual(['urgent']);
			expect(labelChanges[0].payload.added_labels).toEqual([]);
		});
	});

	// ─── Comment Polling (Batched) ──────────────────────────────────────────

	describe('comment polling', () => {
		it('emits comment.created for comments included in batch response', async () => {
			const issue = makeIssueNode({
				createdAt: '2024-01-01T11:00:00.000Z',
				updatedAt: '2024-01-01T12:05:00.000Z',
				comments: [
					{
						id: 'comment-1',
						body: 'Looks good',
						url: 'https://linear.app/comment/1',
						createdAt: '2024-01-01T12:02:00.000Z',
						user: { name: 'Alice' },
					},
				],
			});
			mockExecuteBatchQuery.mockResolvedValue(makeBatchResponse([issue]));
			const source = await createSource();

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			const comments = result.events.filter(
				(e) => e.provenance.platform_event === 'comment.created',
			);
			expect(comments.length).toBe(1);
			expect(comments[0].payload.comment_body).toBe('Looks good');
			expect(comments[0].payload.issue_id).toBe('ENG-1');
		});

		it('includes issue_assignee and issue_creator in comment provenance', async () => {
			const issue = makeIssueNode({
				assignee: { name: 'Alice' },
				creator: { name: 'Bob' },
				createdAt: '2024-01-01T11:00:00.000Z',
				updatedAt: '2024-01-01T12:05:00.000Z',
				comments: [
					{
						id: 'comment-1',
						body: 'Progress update',
						url: 'https://linear.app/comment/1',
						createdAt: '2024-01-01T12:02:00.000Z',
						user: { name: 'Charlie' },
					},
				],
			});
			mockExecuteBatchQuery.mockResolvedValue(makeBatchResponse([issue]));
			const source = await createSource();

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			const comments = result.events.filter(
				(e) => e.provenance.platform_event === 'comment.created',
			);
			expect(comments.length).toBe(1);
			expect(comments[0].provenance.author).toBe('Charlie');
			expect(comments[0].provenance.issue_assignee).toBe('Alice');
			expect(comments[0].provenance.issue_creator).toBe('Bob');
		});

		it('sets issue_assignee to null when issue is unassigned', async () => {
			const issue = makeIssueNode({
				assignee: null,
				creator: { name: 'Bob' },
				createdAt: '2024-01-01T11:00:00.000Z',
				updatedAt: '2024-01-01T12:05:00.000Z',
				comments: [
					{
						id: 'comment-1',
						body: 'Needs triage',
						url: 'https://linear.app/comment/1',
						createdAt: '2024-01-01T12:02:00.000Z',
						user: { name: 'Alice' },
					},
				],
			});
			mockExecuteBatchQuery.mockResolvedValue(makeBatchResponse([issue]));
			const source = await createSource();

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			const comments = result.events.filter(
				(e) => e.provenance.platform_event === 'comment.created',
			);
			expect(comments.length).toBe(1);
			expect(comments[0].provenance.issue_assignee).toBeNull();
			expect(comments[0].provenance.issue_creator).toBe('Bob');
		});
	});

	// ─── State Cache Persistence ────────────────────────────────────────────

	describe('state cache persistence', () => {
		it('persists state cache to disk after poll', async () => {
			const issue = makeIssueNode({
				createdAt: '2024-01-01T12:01:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValue(makeBatchResponse([issue]));
			const source = await createSource();

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

			const issue = makeIssueNode({
				state: { name: 'In Progress' },
				createdAt: '2024-01-01T11:00:00.000Z',
				updatedAt: '2024-01-01T12:05:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValue(makeBatchResponse([issue]));
			const source = await createSource();

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
				createdAt: '2024-01-01T12:01:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValue(makeBatchResponse([issue]));
			const source = await createSource();

			const result = await source.poll('2024-01-01T12:00:00.000Z');
			expect(result.events.length).toBe(1); // new issue detected
		});

		it('saves state cache on shutdown', async () => {
			const issue = makeIssueNode({
				createdAt: '2024-01-01T12:01:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValue(makeBatchResponse([issue]));
			const source = await createSource();

			await source.poll('2024-01-01T12:00:00.000Z');

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
				createdAt: '2024-01-01T12:01:00.000Z',
			});
			const issue2 = makeIssueNode({
				id: 'issue-2',
				identifier: 'ENG-2',
				createdAt: '2024-01-01T12:02:00.000Z',
			});

			mockExecuteBatchQuery
				.mockResolvedValueOnce(makeBatchResponse([issue1], true, 'cursor-1'))
				.mockResolvedValueOnce(makeBatchResponse([issue2], false));

			const source = await createSource();
			const result = await source.poll('2024-01-01T12:00:00.000Z');

			const newIssues = result.events.filter(
				(e) => e.provenance.platform_event === 'issue.created',
			);
			expect(newIssues.length).toBe(2);

			// First call has no cursor, second has cursor-1
			expect(mockExecuteBatchQuery.mock.calls[0][0].cursor).toBeUndefined();
			expect(mockExecuteBatchQuery.mock.calls[1][0].cursor).toBe('cursor-1');
		});
	});

	// ─── Rate Limiting ──────────────────────────────────────────────────────

	describe('rate limiting', () => {
		it('returns empty events on rate limit (429)', async () => {
			mockExecuteBatchQuery.mockRejectedValue(
				Object.assign(new Error('Rate limited'), { status: 429 }),
			);
			const source = await createSource();

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			expect(result.events).toEqual([]);
			expect(result.checkpoint).toBe('2024-01-01T12:00:00.000Z');
		});

		it('returns empty events on RATE_LIMITED GraphQL extension', async () => {
			mockExecuteBatchQuery.mockRejectedValue(
				Object.assign(new Error('Rate limited'), {
					extensions: { code: 'RATE_LIMITED' },
				}),
			);
			const source = await createSource();

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			expect(result.events).toEqual([]);
		});
	});

	// ─── Auth Error Handling ────────────────────────────────────────────────

	describe('auth error handling', () => {
		it('returns empty events on 401', async () => {
			mockExecuteBatchQuery.mockRejectedValue(
				Object.assign(new Error('Unauthorized'), { status: 401 }),
			);
			const source = await createSource();
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			expect(result.events).toEqual([]);
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Auth error'));
		});

		it('returns empty events on 403', async () => {
			mockExecuteBatchQuery.mockRejectedValue(
				Object.assign(new Error('Forbidden'), { status: 403 }),
			);
			const source = await createSource();
			vi.spyOn(console, 'error').mockImplementation(() => {});

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			expect(result.events).toEqual([]);
		});

		it('rethrows unexpected errors', async () => {
			mockExecuteBatchQuery.mockRejectedValue(new Error('Network failure'));
			const source = await createSource();

			await expect(source.poll('2024-01-01T12:00:00.000Z')).rejects.toThrow('Network failure');
		});
	});

	// ─── Checkpoint Advancement ──────────────────────────────────────────────

	describe('checkpoint advancement', () => {
		it('advances checkpoint to latest event timestamp', async () => {
			const issue = makeIssueNode({
				createdAt: '2024-01-01T12:05:00.000Z',
				updatedAt: '2024-01-01T12:05:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValue(makeBatchResponse([issue]));
			const source = await createSource();

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			expect(result.checkpoint > '2024-01-01T12:00:00.000Z').toBe(true);
		});

		it('uses default 5-minute lookback when no checkpoint', async () => {
			mockExecuteBatchQuery.mockResolvedValue(makeBatchResponse([]));
			const source = await createSource();

			const before = Date.now();
			const result = await source.poll(null);

			const cpTime = new Date(result.checkpoint).getTime();
			expect(cpTime).toBeGreaterThan(before - 6 * 60 * 1000);
			expect(cpTime).toBeLessThanOrEqual(before);
		});
	});

	// ─── Multiple Changes in One Poll ────────────────────────────────────────

	describe('multiple changes in one poll', () => {
		it('detects state + assignee + priority + label changes simultaneously', async () => {
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

			const issue = makeIssueNode({
				state: { name: 'Done' },
				assignee: { name: 'Bob' },
				priority: 1,
				labels: [{ name: 'bug' }, { name: 'urgent' }],
				createdAt: '2024-01-01T11:00:00.000Z',
				updatedAt: '2024-01-01T12:05:00.000Z',
			});
			mockExecuteBatchQuery.mockResolvedValue(makeBatchResponse([issue]));
			const source = await createSource();

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
			rmSync(newDir, { recursive: true, force: true });
		});
	});

	// ─── Batch Query Integration ────────────────────────────────────────────

	describe('batch query integration', () => {
		it('passes correct parameters to executeBatchQuery', async () => {
			mockExecuteBatchQuery.mockResolvedValue(makeBatchResponse([]));
			const source = await createSource({ project: 'MyProject' });

			await source.poll('2024-01-01T12:00:00.000Z');

			expect(mockExecuteBatchQuery).toHaveBeenCalledWith({
				apiKey: 'test-api-key',
				teamKey: 'ENG',
				since: '2024-01-01T12:00:00.000Z',
				projectName: 'MyProject',
				cursor: undefined,
				fetch: expect.any(Function),
			});
		});

		it('fetches issues and comments in single batch', async () => {
			const issue = makeIssueNode({
				createdAt: '2024-01-01T12:01:00.000Z',
				comments: [
					{
						id: 'comment-1',
						body: 'Test comment',
						url: 'https://linear.app/comment/1',
						createdAt: '2024-01-01T12:02:00.000Z',
						user: { name: 'Alice' },
					},
				],
			});
			mockExecuteBatchQuery.mockResolvedValue(makeBatchResponse([issue]));
			const source = await createSource();

			const result = await source.poll('2024-01-01T12:00:00.000Z');

			// Both issue creation and comment should come from single batch call
			expect(mockExecuteBatchQuery).toHaveBeenCalledTimes(1);
			expect(result.events.length).toBe(2);
			expect(result.events.map((e) => e.provenance.platform_event).sort()).toEqual([
				'comment.created',
				'issue.created',
			]);
		});
	});
});
