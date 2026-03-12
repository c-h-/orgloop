/**
 * Tests for GitHubSource polling logic.
 *
 * PR-related events (reviews, closed, opened, ready-for-review) now use a
 * batched GraphQL query via executeBatchPRQuery. REST endpoints are still
 * used for review comments, issue comments, workflow runs, and check suites.
 */

import type { BatchPRResult } from '../graphql.js';
import { GitHubSource } from '../source.js';

// ─── Mock the graphql module ────────────────────────────────────────────────

vi.mock('../graphql.js', () => ({
	executeBatchPRQuery: vi.fn(),
}));

import { executeBatchPRQuery } from '../graphql.js';

const mockExecuteBatchPRQuery = vi.mocked(executeBatchPRQuery);

// ─── Mock Octokit (for REST endpoints) ──────────────────────────────────────

function createMockOctokit() {
	const pulls = {
		get: vi.fn(),
		listReviewCommentsForRepo: vi.fn(),
	};
	const issues = {
		listCommentsForRepo: vi.fn(),
		listEventsForRepo: vi.fn(),
	};
	const actions = {
		listWorkflowRunsForRepo: vi.fn(),
	};
	const checks = {
		listSuitesForRef: vi.fn(),
	};

	// paginate calls the endpoint function and returns data directly
	const paginate = vi.fn(async (endpoint: unknown, params: unknown) => {
		const fn = endpoint as (...args: unknown[]) => Promise<{ data: unknown }>;
		const result = await fn(params);
		if (Array.isArray(result.data)) {
			return result.data;
		}
		if (
			result.data &&
			typeof result.data === 'object' &&
			'workflow_runs' in (result.data as Record<string, unknown>)
		) {
			return (result.data as Record<string, unknown>).workflow_runs;
		}
		return result.data;
	}) as ReturnType<typeof vi.fn> & {
		iterator: ReturnType<typeof vi.fn>;
	};

	paginate.iterator = vi.fn((endpoint: unknown, params: unknown) => {
		const fn = endpoint as (...args: unknown[]) => Promise<{ data: unknown }>;
		return {
			async *[Symbol.asyncIterator]() {
				const result = await fn(params);
				let items: unknown[];
				if (Array.isArray(result.data)) {
					items = result.data;
				} else if (
					result.data &&
					typeof result.data === 'object' &&
					'workflow_runs' in (result.data as Record<string, unknown>)
				) {
					items = (result.data as Record<string, unknown>).workflow_runs as unknown[];
				} else {
					items = [];
				}
				yield { data: items, headers: {} };
			},
		};
	});

	return {
		pulls,
		issues,
		actions,
		checks,
		paginate,
	};
}

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makePR(overrides: Record<string, unknown> = {}) {
	return {
		number: 1,
		title: 'Test PR',
		updated_at: '2024-01-15T10:00:00Z',
		created_at: '2024-01-14T10:00:00Z',
		closed_at: null,
		merged: false,
		draft: false,
		state: 'open',
		html_url: 'https://github.com/owner/repo/pull/1',
		user: { login: 'alice', type: 'User' },
		head: { ref: 'feature-branch' },
		base: { ref: 'main' },
		...overrides,
	};
}

function makeReview(overrides: Record<string, unknown> = {}) {
	return {
		id: 100,
		state: 'approved',
		body: 'LGTM',
		submitted_at: '2024-01-15T10:00:00Z',
		html_url: 'https://github.com/owner/repo/pull/1#pullrequestreview-100',
		user: { login: 'bob', type: 'User' },
		...overrides,
	};
}

function makeReviewComment(overrides: Record<string, unknown> = {}) {
	return {
		id: 200,
		body: 'Needs a fix here',
		updated_at: '2024-01-15T10:00:00Z',
		html_url: 'https://github.com/owner/repo/pull/1#discussion_r200',
		pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/1',
		diff_hunk: '@@ -1,3 +1,3 @@',
		path: 'src/index.ts',
		user: { login: 'bob', type: 'User' },
		...overrides,
	};
}

function makeIssueComment(overrides: Record<string, unknown> = {}) {
	return {
		id: 300,
		body: 'Thanks for the PR!',
		updated_at: '2024-01-15T10:00:00Z',
		html_url: 'https://github.com/owner/repo/issues/1#issuecomment-300',
		issue_url: 'https://api.github.com/repos/owner/repo/issues/1',
		user: { login: 'carol', type: 'User' },
		...overrides,
	};
}

function makeWorkflowRun(overrides: Record<string, unknown> = {}) {
	return {
		id: 400,
		name: 'CI',
		run_number: 42,
		conclusion: 'failure',
		status: 'completed',
		updated_at: '2024-01-15T10:00:00Z',
		html_url: 'https://github.com/owner/repo/actions/runs/400',
		head_branch: 'main',
		head_sha: 'abc123',
		actor: { login: 'alice', type: 'User' },
		...overrides,
	};
}

function makeCheckSuite(overrides: Record<string, unknown> = {}) {
	return {
		id: 500,
		status: 'completed',
		conclusion: 'success',
		updated_at: '2024-01-15T10:00:00Z',
		url: 'https://api.github.com/repos/owner/repo/check-suites/500',
		head_branch: 'main',
		head_sha: 'abc123',
		before: 'def456',
		after: 'abc123',
		app: { slug: 'github-actions', name: 'GitHub Actions' },
		...overrides,
	};
}

function makeIssueEvent(overrides: Record<string, unknown> = {}) {
	return {
		id: 600,
		event: 'opened',
		created_at: '2024-01-15T10:00:00Z',
		actor: { login: 'alice', type: 'User' },
		issue: {
			number: 10,
			title: 'Bug report',
			state: 'open',
			user: { login: 'alice', type: 'User' },
			html_url: 'https://github.com/owner/repo/issues/10',
		},
		...overrides,
	};
}

/** Build a BatchPRResult for the mocked executeBatchPRQuery */
function makeBatchResult(overrides: Partial<BatchPRResult> = {}): BatchPRResult {
	return {
		pulls: [],
		reviews: [],
		closedPRs: [],
		openedPRs: [],
		readyForReviewPRs: [],
		rateLimit: { remaining: 4999, resetAt: new Date(Date.now() + 3600000) },
		...overrides,
	};
}

// ─── Setup ───────────────────────────────────────────────────────────────────

async function createSource(
	events: string[],
	mockOctokit: ReturnType<typeof createMockOctokit>,
	opts?: { authors?: string[]; initial_lookback?: string },
) {
	const source = new GitHubSource();
	process.env.GITHUB_TOKEN = 'test-token';
	await source.init({
		id: 'github-test',
		connector: 'github',
		config: {
			repo: 'owner/repo',
			events,
			token: '${GITHUB_TOKEN}',
			...(opts?.authors ? { authors: opts.authors } : {}),
			...(opts?.initial_lookback ? { initial_lookback: opts.initial_lookback } : {}),
		},
	});
	// Replace the real octokit with mock (for REST endpoints)
	(source as unknown as Record<string, unknown>).octokit = mockOctokit;
	return source;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GitHubSource', () => {
	afterEach(() => {
		process.env.GITHUB_TOKEN = undefined;
		vi.restoreAllMocks();
		mockExecuteBatchPRQuery.mockReset();
	});

	describe('init', () => {
		it('initializes with repo, events, and token', async () => {
			process.env.GITHUB_TOKEN = 'ghp_test';
			const source = new GitHubSource();
			await source.init({
				id: 'gh',
				connector: 'github',
				config: {
					repo: 'owner/repo',
					events: ['pull_request.review_submitted'],
					token: '${GITHUB_TOKEN}',
				},
			});
			expect(source.id).toBe('github');
		});

		it('throws when env var is not set', async () => {
			process.env.GITHUB_TOKEN = undefined;
			const source = new GitHubSource();
			await expect(
				source.init({
					id: 'gh',
					connector: 'github',
					config: {
						repo: 'owner/repo',
						events: [],
						token: '${MISSING_VAR}',
					},
				}),
			).rejects.toThrow('Environment variable MISSING_VAR is not set');
		});

		it('accepts custom initial_lookback', async () => {
			process.env.GITHUB_TOKEN = 'ghp_test';
			const source = new GitHubSource();
			await source.init({
				id: 'gh',
				connector: 'github',
				config: {
					repo: 'owner/repo',
					events: [],
					token: '${GITHUB_TOKEN}',
					initial_lookback: '24h',
				},
			});
			expect(source.id).toBe('github');
		});
	});

	describe('pollReviews (batch GraphQL)', () => {
		it('fetches reviews via batch query and returns review events', async () => {
			const mock = createMockOctokit();
			const pr = makePR({ number: 1 });
			const review = makeReview({ submitted_at: '2024-01-15T10:00:00Z' });

			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr],
					reviews: [{ review, pr }],
				}),
			);

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('pull_request.review_submitted');
			expect(result.events[0].payload.review_state).toBe('approved');
			expect(result.events[0].provenance.author).toBe('bob');
			expect(mockExecuteBatchPRQuery).toHaveBeenCalledTimes(1);
		});

		it('handles multiple PRs with reviews from batch', async () => {
			const mock = createMockOctokit();
			const pr1 = makePR({ number: 1, updated_at: '2024-01-15T10:00:00Z' });
			const pr2 = makePR({ number: 2, title: 'PR 2', updated_at: '2024-01-15T11:00:00Z' });
			const review1 = makeReview({ submitted_at: '2024-01-15T10:00:00Z' });
			const review2 = makeReview({
				submitted_at: '2024-01-15T11:00:00Z',
				id: 102,
			});

			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr1, pr2],
					reviews: [
						{ review: review1, pr: pr1 },
						{ review: review2, pr: pr2 },
					],
				}),
			);

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(2);
		});
	});

	describe('pollReviewComments (REST)', () => {
		it('returns review comment events with pagination', async () => {
			const mock = createMockOctokit();
			const pr = makePR();
			const comment = makeReviewComment();

			mockExecuteBatchPRQuery.mockResolvedValue(makeBatchResult({ pulls: [pr] }));
			mock.pulls.listReviewCommentsForRepo.mockResolvedValue({ data: [comment] });

			const source = await createSource(['pull_request_review_comment'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('pull_request_review_comment');
			expect(result.events[0].payload.comment_body).toBe('Needs a fix here');
			expect(result.events[0].payload.path).toBe('src/index.ts');
		});

		it('fetches PR data when comment references a PR not in cache', async () => {
			const mock = createMockOctokit();
			mockExecuteBatchPRQuery.mockResolvedValue(makeBatchResult());

			const comment = makeReviewComment({
				pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/42',
			});
			mock.pulls.listReviewCommentsForRepo.mockResolvedValue({ data: [comment] });

			const fetchedPR = makePR({
				number: 42,
				title: 'Fetched PR',
				user: { login: 'alice', type: 'User' },
			});
			mock.pulls.get.mockResolvedValue({ data: fetchedPR });

			const source = await createSource(['pull_request_review_comment'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.pr_author).toBe('alice');
			expect(mock.pulls.get).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 42 }));
		});

		it('caches fetched PR so subsequent comments skip the API call', async () => {
			const mock = createMockOctokit();
			mockExecuteBatchPRQuery.mockResolvedValue(makeBatchResult());

			const comment1 = makeReviewComment({
				id: 201,
				pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/42',
				updated_at: '2024-01-15T10:00:00Z',
			});
			const comment2 = makeReviewComment({
				id: 202,
				pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/42',
				updated_at: '2024-01-15T11:00:00Z',
			});
			mock.pulls.listReviewCommentsForRepo.mockResolvedValue({
				data: [comment1, comment2],
			});

			const fetchedPR = makePR({
				number: 42,
				user: { login: 'alice', type: 'User' },
			});
			mock.pulls.get.mockResolvedValue({ data: fetchedPR });

			const source = await createSource(['pull_request_review_comment'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(2);
			expect(result.events[0].provenance.pr_author).toBe('alice');
			expect(result.events[1].provenance.pr_author).toBe('alice');
			expect(mock.pulls.get).toHaveBeenCalledTimes(1);
		});

		it('falls back to unknown pr_author when fetch fails', async () => {
			const mock = createMockOctokit();
			mockExecuteBatchPRQuery.mockResolvedValue(makeBatchResult());

			const comment = makeReviewComment({
				pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/99',
			});
			mock.pulls.listReviewCommentsForRepo.mockResolvedValue({ data: [comment] });
			mock.pulls.get.mockRejectedValue(new Error('Not found'));

			const source = await createSource(['pull_request_review_comment'], mock);
			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.pr_author).toBe('unknown');
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch PR #99'));
			consoleSpy.mockRestore();
		});
	});

	describe('review state dedup — review_id in events (Fixes #37)', () => {
		it('includes review_id in provenance and payload', async () => {
			const mock = createMockOctokit();
			const pr = makePR({ number: 1 });
			const review = makeReview({
				id: 555,
				state: 'approved',
				submitted_at: '2024-01-15T10:00:00Z',
			});

			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr],
					reviews: [{ review, pr }],
				}),
			);

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.review_id).toBe(555);
			expect(result.events[0].payload.review_id).toBe(555);
		});

		it('two reviews on same PR with different states produce different review_ids', async () => {
			const mock = createMockOctokit();
			const pr = makePR({ number: 1, updated_at: '2024-01-15T10:01:00Z' });
			const commentReview = makeReview({
				id: 100,
				state: 'commented',
				body: 'needs work',
				submitted_at: '2024-01-15T10:00:00Z',
				user: { login: 'bot[bot]', type: 'Bot' },
			});
			const approvalReview = makeReview({
				id: 101,
				state: 'approved',
				body: 'LGTM',
				submitted_at: '2024-01-15T10:01:00Z',
				user: { login: 'alice', type: 'User' },
			});

			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr],
					reviews: [
						{ review: commentReview, pr },
						{ review: approvalReview, pr },
					],
				}),
			);

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(2);
			expect(result.events[0].provenance.review_id).toBe(100);
			expect(result.events[1].provenance.review_id).toBe(101);
			expect(result.events[0].provenance.review_state).toBe('commented');
			expect(result.events[1].provenance.review_state).toBe('approved');
		});

		it('same review polled twice produces same review_id for stable dedup', async () => {
			const mock = createMockOctokit();
			const pr = makePR({ number: 1, updated_at: '2024-01-15T10:00:00Z' });
			const review = makeReview({
				id: 200,
				state: 'approved',
				submitted_at: '2024-01-15T10:00:00Z',
			});

			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr],
					reviews: [{ review, pr }],
				}),
			);

			const source = await createSource(['pull_request.review_submitted'], mock);

			const result1 = await source.poll('2024-01-15T09:00:00Z');
			expect(result1.events).toHaveLength(1);

			// Second poll: PR has updated_at changed, bypassing cache
			const pr2 = makePR({ number: 1, updated_at: '2024-01-15T10:05:00Z' });
			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr2],
					reviews: [{ review, pr: pr2 }],
				}),
			);

			const result2 = await source.poll('2024-01-15T09:00:00Z');
			expect(result2.events).toHaveLength(1);

			expect(result1.events[0].provenance.review_id).toBe(200);
			expect(result2.events[0].provenance.review_id).toBe(200);
		});
	});

	describe('pollIssueComments (REST)', () => {
		it('returns issue comment events', async () => {
			const mock = createMockOctokit();
			const comment = makeIssueComment();

			mock.issues.listCommentsForRepo.mockResolvedValue({ data: [comment] });

			const source = await createSource(['issue_comment'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('issue_comment');
			expect(result.events[0].payload.comment_body).toBe('Thanks for the PR!');
		});

		it('filters out comments older than since', async () => {
			const mock = createMockOctokit();
			const oldComment = makeIssueComment({
				updated_at: '2024-01-14T08:00:00Z',
			});
			const newComment = makeIssueComment({
				updated_at: '2024-01-15T10:00:00Z',
				id: 301,
			});

			mock.issues.listCommentsForRepo.mockResolvedValue({
				data: [oldComment, newComment],
			});

			const source = await createSource(['issue_comment'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
		});
	});

	describe('pollClosedPRs (batch GraphQL)', () => {
		it('returns closed PR events', async () => {
			const mock = createMockOctokit();
			const pr = makePR({
				state: 'closed',
				closed_at: '2024-01-15T10:00:00Z',
				merged: false,
			});

			mockExecuteBatchPRQuery.mockResolvedValue(makeBatchResult({ pulls: [pr], closedPRs: [pr] }));

			const source = await createSource(['pull_request.closed'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('pull_request.closed');
			expect(result.events[0].payload.action).toBe('closed');
		});

		it('returns merged PR events', async () => {
			const mock = createMockOctokit();
			const pr = makePR({
				state: 'closed',
				closed_at: '2024-01-15T10:00:00Z',
				merged: true,
				merged_by: { login: 'bob' },
			});

			mockExecuteBatchPRQuery.mockResolvedValue(makeBatchResult({ pulls: [pr], closedPRs: [pr] }));

			const source = await createSource(['pull_request.merged'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('pull_request.merged');
			expect(result.events[0].payload.merged_by).toBe('bob');
		});
	});

	describe('pollOpenedPRs (batch GraphQL)', () => {
		it('returns opened PR events', async () => {
			const mock = createMockOctokit();
			const pr = makePR({ created_at: '2024-01-15T10:00:00Z' });

			mockExecuteBatchPRQuery.mockResolvedValue(makeBatchResult({ pulls: [pr], openedPRs: [pr] }));

			const source = await createSource(['pull_request.opened'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('pull_request.opened');
			expect(result.events[0].payload.action).toBe('opened');
			expect(result.events[0].payload.head_ref).toBe('feature-branch');
			expect(result.events[0].payload.base_ref).toBe('main');
		});

		it('filters out PRs created before checkpoint (handled by batch)', async () => {
			const mock = createMockOctokit();

			// Batch returns no openedPRs (the filtering is done in graphql.ts)
			mockExecuteBatchPRQuery.mockResolvedValue(makeBatchResult());

			const source = await createSource(['pull_request.opened'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(0);
		});
	});

	describe('pollReadyForReviewPRs (batch GraphQL)', () => {
		it('returns non-draft PRs updated after checkpoint', async () => {
			const mock = createMockOctokit();
			const pr = makePR({
				draft: false,
				updated_at: '2024-01-15T10:00:00Z',
			});

			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({ pulls: [pr], readyForReviewPRs: [pr] }),
			);

			const source = await createSource(['pull_request.ready_for_review'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('pull_request.ready_for_review');
			expect(result.events[0].payload.action).toBe('ready_for_review');
		});

		it('excludes draft PRs (handled by batch)', async () => {
			const mock = createMockOctokit();

			// Batch returns no readyForReviewPRs for draft PRs
			mockExecuteBatchPRQuery.mockResolvedValue(makeBatchResult());

			const source = await createSource(['pull_request.ready_for_review'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(0);
		});
	});

	describe('pollFailedWorkflowRuns (REST)', () => {
		it('returns failed workflow run events', async () => {
			const mock = createMockOctokit();
			const run = makeWorkflowRun();

			mock.actions.listWorkflowRunsForRepo.mockResolvedValue({
				data: { workflow_runs: [run] },
			});

			const source = await createSource(['workflow_run.completed'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('workflow_run.completed');
			expect(result.events[0].payload.conclusion).toBe('failure');
			expect(result.events[0].payload.workflow_name).toBe('CI');
		});
	});

	describe('pollCheckSuites (REST)', () => {
		it('returns completed check suite events', async () => {
			const mock = createMockOctokit();
			const suite = makeCheckSuite();

			mock.checks.listSuitesForRef.mockResolvedValue({
				data: { check_suites: [suite] },
			});

			const source = await createSource(['check_suite.completed'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('check_suite.completed');
			expect(result.events[0].payload.conclusion).toBe('success');
			expect(result.events[0].payload.app_name).toBe('GitHub Actions');
			expect(result.events[0].provenance.author_type).toBe('bot');
		});

		it('excludes non-completed check suites', async () => {
			const mock = createMockOctokit();
			const suite = makeCheckSuite({
				status: 'in_progress',
				updated_at: '2024-01-15T10:00:00Z',
			});

			mock.checks.listSuitesForRef.mockResolvedValue({
				data: { check_suites: [suite] },
			});

			const source = await createSource(['check_suite.completed'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(0);
		});
	});

	describe('pollIssueEvents (REST)', () => {
		it('returns issue opened events', async () => {
			const mock = createMockOctokit();
			const event = makeIssueEvent();

			mock.issues.listEventsForRepo.mockResolvedValue({ data: [event] });

			const source = await createSource(['issues.opened'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('issues.opened');
			expect(result.events[0].payload.action).toBe('opened');
			expect(result.events[0].payload.issue_number).toBe(10);
		});

		it('returns issue labeled events with label in provenance', async () => {
			const mock = createMockOctokit();
			const event = makeIssueEvent({
				event: 'labeled',
				label: { name: 'bug', color: 'd73a4a' },
			});

			mock.issues.listEventsForRepo.mockResolvedValue({ data: [event] });

			const source = await createSource(['issues.labeled'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('issues.labeled');
			expect(result.events[0].provenance.label).toBe('bug');
			expect(result.events[0].payload.label).toBe('bug');
		});

		it('returns issue assigned events', async () => {
			const mock = createMockOctokit();
			const event = makeIssueEvent({
				event: 'assigned',
				assignee: { login: 'bob', type: 'User' },
			});

			mock.issues.listEventsForRepo.mockResolvedValue({ data: [event] });

			const source = await createSource(['issues.assigned'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('issues.assigned');
			expect(result.events[0].payload.assignee).toBe('bob');
		});

		it('filters out events older than since', async () => {
			const mock = createMockOctokit();
			const oldEvent = makeIssueEvent({ created_at: '2024-01-14T08:00:00Z' });
			const newEvent = makeIssueEvent({
				id: 601,
				created_at: '2024-01-15T10:00:00Z',
			});

			let pageCount = 0;
			mock.paginate.iterator.mockReturnValue({
				async *[Symbol.asyncIterator]() {
					pageCount++;
					yield { data: [newEvent], headers: {} };
					pageCount++;
					yield { data: [oldEvent], headers: {} };
				},
			});

			const source = await createSource(['issues.opened'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(pageCount).toBe(2);
		});

		it('skips events on pull requests', async () => {
			const mock = createMockOctokit();
			const prEvent = makeIssueEvent({
				issue: {
					number: 5,
					title: 'PR labeled',
					state: 'open',
					user: { login: 'alice', type: 'User' },
					html_url: 'https://github.com/owner/repo/pull/5',
					pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/5' },
				},
			});

			mock.issues.listEventsForRepo.mockResolvedValue({ data: [prEvent] });

			const source = await createSource(['issues.opened'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(0);
		});

		it('only fetches event types configured', async () => {
			const mock = createMockOctokit();
			const openedEvent = makeIssueEvent({ event: 'opened' });
			const labeledEvent = makeIssueEvent({
				id: 601,
				event: 'labeled',
				label: { name: 'bug' },
			});
			const assignedEvent = makeIssueEvent({
				id: 602,
				event: 'assigned',
				assignee: { login: 'bob' },
			});

			mock.issues.listEventsForRepo.mockResolvedValue({
				data: [openedEvent, labeledEvent, assignedEvent],
			});

			// Only subscribe to issues.labeled
			const source = await createSource(['issues.labeled'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('issues.labeled');
		});

		it('handles multiple issue event types together', async () => {
			const mock = createMockOctokit();
			const openedEvent = makeIssueEvent({ event: 'opened' });
			const labeledEvent = makeIssueEvent({
				id: 601,
				event: 'labeled',
				label: { name: 'enhancement' },
			});

			mock.issues.listEventsForRepo.mockResolvedValue({
				data: [openedEvent, labeledEvent],
			});

			const source = await createSource(['issues.opened', 'issues.labeled'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(2);
		});

		it('does not poll when no issue events configured', async () => {
			const mock = createMockOctokit();
			mockExecuteBatchPRQuery.mockResolvedValue(makeBatchResult());

			const source = await createSource(['pull_request.review_submitted'], mock);
			await source.poll('2024-01-15T09:00:00Z');

			// listEventsForRepo should never be called
			expect(mock.issues.listEventsForRepo).not.toHaveBeenCalled();
		});
	});

	describe('error handling', () => {
		it('returns empty events on rate limit (429)', async () => {
			const mock = createMockOctokit();
			const error = Object.assign(new Error('rate limited'), { status: 429 });

			mockExecuteBatchPRQuery.mockRejectedValue(error);

			const source = await createSource(['pull_request.review_submitted'], mock);
			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(0);
			consoleSpy.mockRestore();
		});

		it('returns empty events on auth error (401)', async () => {
			const mock = createMockOctokit();
			const error = Object.assign(new Error('Bad credentials'), { status: 401 });

			mockExecuteBatchPRQuery.mockRejectedValue(error);

			const source = await createSource(['pull_request.review_submitted'], mock);
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(0);
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[github] Auth error'));
			consoleSpy.mockRestore();
		});

		it('returns empty events on forbidden (403)', async () => {
			const mock = createMockOctokit();
			const error = Object.assign(new Error('Forbidden'), { status: 403 });

			mockExecuteBatchPRQuery.mockRejectedValue(error);

			const source = await createSource(['pull_request.review_submitted'], mock);
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(0);
			consoleSpy.mockRestore();
		});

		it('rethrows non-HTTP errors', async () => {
			const mock = createMockOctokit();
			const error = new Error('Network failure');

			mockExecuteBatchPRQuery.mockRejectedValue(error);

			const source = await createSource(['pull_request.review_submitted'], mock);
			await expect(source.poll('2024-01-15T09:00:00Z')).rejects.toThrow('Network failure');
		});
	});

	describe('author filtering', () => {
		it('filters events by author when authors config is set', async () => {
			const mock = createMockOctokit();
			const pr = makePR({ updated_at: '2024-01-15T10:00:00Z' });
			const reviewByAlice = makeReview({
				submitted_at: '2024-01-15T10:00:00Z',
				user: { login: 'alice', type: 'User' },
			});
			const reviewByBob = makeReview({
				submitted_at: '2024-01-15T10:00:00Z',
				user: { login: 'bob', type: 'User' },
				id: 101,
			});

			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr],
					reviews: [
						{ review: reviewByAlice, pr },
						{ review: reviewByBob, pr },
					],
				}),
			);

			const source = await createSource(['pull_request.review_submitted'], mock, {
				authors: ['bob'],
			});
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.author).toBe('bob');
		});

		it('returns all events when no authors filter', async () => {
			const mock = createMockOctokit();
			const pr = makePR({ updated_at: '2024-01-15T10:00:00Z' });
			const review1 = makeReview({
				submitted_at: '2024-01-15T10:00:00Z',
				user: { login: 'alice', type: 'User' },
			});
			const review2 = makeReview({
				submitted_at: '2024-01-15T10:00:00Z',
				user: { login: 'bob', type: 'User' },
				id: 101,
			});

			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr],
					reviews: [
						{ review: review1, pr },
						{ review: review2, pr },
					],
				}),
			);

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(2);
		});
	});

	describe('checkpoint advancement', () => {
		it('advances checkpoint to latest event timestamp', async () => {
			const mock = createMockOctokit();
			const pr = makePR({ updated_at: '2024-01-15T12:00:00Z' });
			const review1 = makeReview({ submitted_at: '2024-01-15T10:00:00Z' });
			const review2 = makeReview({
				submitted_at: '2024-01-15T12:00:00Z',
				id: 101,
			});

			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr],
					reviews: [
						{ review: review1, pr },
						{ review: review2, pr },
					],
				}),
			);

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.checkpoint > '2024-01-15T09:00:00Z').toBe(true);
		});

		it('returns lookback-based checkpoint when no prior checkpoint and no events', async () => {
			const mock = createMockOctokit();
			mockExecuteBatchPRQuery.mockResolvedValue(makeBatchResult());

			const source = await createSource(['pull_request.review_submitted'], mock);
			const before = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
			const result = await source.poll(null);

			expect(result.events).toHaveLength(0);
			expect(result.checkpoint > '2020-01-01T00:00:00Z').toBe(true);
			const checkpointDate = new Date(result.checkpoint);
			const lookbackDate = new Date(before);
			expect(Math.abs(checkpointDate.getTime() - lookbackDate.getTime())).toBeLessThan(5000);
		});
	});

	describe('initial lookback window', () => {
		it('uses 7d default lookback when no checkpoint exists', async () => {
			const mock = createMockOctokit();
			const pr = makePR({
				updated_at: new Date().toISOString(),
				created_at: new Date().toISOString(),
			});
			const review = makeReview({ submitted_at: new Date().toISOString() });

			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr],
					reviews: [{ review, pr }],
				}),
			);

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll(null);

			expect(result.events).toHaveLength(1);
		});

		it('respects custom initial_lookback config', async () => {
			const mock = createMockOctokit();
			const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
			const pr = makePR({ updated_at: twoDaysAgo });
			const review = makeReview({ submitted_at: twoDaysAgo });

			// With 1d lookback, batch still returns the data — but the since filter
			// excludes the 2-day-old review (batch filtering happens in graphql.ts)
			mockExecuteBatchPRQuery.mockResolvedValue(makeBatchResult());

			const source1d = await createSource(['pull_request.review_submitted'], mock, {
				initial_lookback: '1d',
			});
			const result1d = await source1d.poll(null);
			expect(result1d.events).toHaveLength(0);

			// With 3d lookback, the review is included
			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr],
					reviews: [{ review, pr }],
				}),
			);

			const source3d = await createSource(['pull_request.review_submitted'], mock, {
				initial_lookback: '3d',
			});
			const result3d = await source3d.poll(null);
			expect(result3d.events).toHaveLength(1);
		});

		it('does not apply lookback when checkpoint exists', async () => {
			const mock = createMockOctokit();
			const pr = makePR();
			const review = makeReview({ submitted_at: '2024-01-15T10:00:00Z' });

			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr],
					reviews: [{ review, pr }],
				}),
			);

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
		});
	});

	describe('null checkpoint (first poll)', () => {
		it('returns events within lookback window when no checkpoint exists', async () => {
			const mock = createMockOctokit();
			const recentDate = new Date().toISOString();
			const pr = makePR({ updated_at: recentDate });
			const review = makeReview({ submitted_at: recentDate });

			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr],
					reviews: [{ review, pr }],
				}),
			);

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll(null);

			expect(result.events).toHaveLength(1);
		});
	});

	describe('bot detection', () => {
		it('detects bot authors by [bot] suffix', async () => {
			const mock = createMockOctokit();
			const pr = makePR();
			const botReview = makeReview({
				submitted_at: '2024-01-15T10:00:00Z',
				user: { login: 'dependabot[bot]', type: 'Bot' },
			});

			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr],
					reviews: [{ review: botReview, pr }],
				}),
			);

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.author_type).toBe('bot');
		});
	});

	describe('event structure', () => {
		it('produces well-formed OrgLoop events', async () => {
			const mock = createMockOctokit();
			const pr = makePR();
			const review = makeReview({ submitted_at: '2024-01-15T10:00:00Z' });

			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr],
					reviews: [{ review, pr }],
				}),
			);

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			const event = result.events[0];
			expect(event.id).toMatch(/^evt_/);
			expect(event.type).toBe('resource.changed');
			expect(event.source).toBe('github-test');
			expect(event.timestamp).toBeDefined();
			expect(event.trace_id).toMatch(/^trc_/);
			expect(event.provenance.platform).toBe('github');
			expect(event.provenance.repo).toBe('owner/repo');
		});
	});

	describe('rate limit awareness', () => {
		it('treats 403 with rate limit state as rate limit, not auth error', async () => {
			const mock = createMockOctokit();
			const rateLimitError = Object.assign(new Error('API rate limit exceeded'), {
				status: 403,
				response: {
					headers: {
						'x-ratelimit-remaining': '0',
						'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
					},
				},
			});

			mockExecuteBatchPRQuery.mockRejectedValue(rateLimitError);

			const source = await createSource(['pull_request.review_submitted'], mock);
			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(0);
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Rate limited'));
			expect(errorSpy).not.toHaveBeenCalled();
			consoleSpy.mockRestore();
			errorSpy.mockRestore();
		});

		it('warns when rate limit is low', async () => {
			const mock = createMockOctokit();
			const pr = makePR();
			const review = makeReview({ submitted_at: '2024-01-15T10:00:00Z' });

			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr],
					reviews: [{ review, pr }],
				}),
			);

			const source = await createSource(['pull_request.review_submitted'], mock);

			// Simulate low rate limit state
			(source as unknown as Record<string, unknown>).rateLimit = {
				remaining: 50,
				resetAt: new Date(Date.now() + 3600000),
			};

			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			await source.poll('2024-01-15T09:00:00Z');

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('Rate limit low: 50 requests remaining'),
			);
			consoleSpy.mockRestore();
		});
	});

	describe('epoch checkpoint treated as no checkpoint', () => {
		it('applies lookback window when checkpoint is epoch', async () => {
			const mock = createMockOctokit();

			// Batch returns nothing for the lookback window (old data filtered out)
			mockExecuteBatchPRQuery.mockResolvedValue(makeBatchResult());

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll('1970-01-01T00:00:00.000Z');

			expect(result.events).toHaveLength(0);
			expect(result.checkpoint > '2020-01-01T00:00:00Z').toBe(true);
		});

		it('applies lookback window when checkpoint is epoch (zero)', async () => {
			const mock = createMockOctokit();
			const recentDate = new Date().toISOString();
			const pr = makePR({ updated_at: recentDate });
			const review = makeReview({ submitted_at: recentDate });

			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr],
					reviews: [{ review, pr }],
				}),
			);

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll('1970-01-01T00:00:00.000Z');

			expect(result.events).toHaveLength(1);
		});
	});

	describe('batch GraphQL pagination', () => {
		it('executeBatchPRQuery handles pagination internally (single mock call)', async () => {
			const mock = createMockOctokit();
			const pr = makePR();
			const review = makeReview({ submitted_at: '2024-01-15T10:00:00Z' });

			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr],
					reviews: [{ review, pr }],
				}),
			);

			const source = await createSource(['pull_request.review_submitted'], mock);
			await source.poll('2024-01-15T09:00:00Z');

			// Only one call to batch query — pagination is internal
			expect(mockExecuteBatchPRQuery).toHaveBeenCalledTimes(1);
		});
	});

	describe('workflow run pagination early-exit (REST)', () => {
		it('stops paginating when all runs on a page are older than since', async () => {
			const mock = createMockOctokit();
			const recentRun = makeWorkflowRun({
				id: 1,
				updated_at: '2024-01-15T10:00:00Z',
			});
			const oldRun = makeWorkflowRun({
				id: 2,
				updated_at: '2024-01-10T10:00:00Z',
			});

			let pageCount = 0;
			mock.paginate.iterator.mockReturnValue({
				async *[Symbol.asyncIterator]() {
					pageCount++;
					yield { data: [recentRun], headers: {} };
					pageCount++;
					yield { data: [oldRun], headers: {} };
					pageCount++;
					yield { data: [oldRun], headers: {} };
				},
			});

			const source = await createSource(['workflow_run.completed'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(pageCount).toBe(2);
			expect(result.events).toHaveLength(1);
		});
	});

	describe('batch and REST combined', () => {
		it('single batch call serves both reviews and closed PRs', async () => {
			const mock = createMockOctokit();
			const pr = makePR({
				number: 1,
				state: 'closed',
				closed_at: '2024-01-15T10:00:00Z',
				merged: false,
			});
			const review = makeReview({ submitted_at: '2024-01-15T10:00:00Z' });

			mockExecuteBatchPRQuery.mockResolvedValue(
				makeBatchResult({
					pulls: [pr],
					reviews: [{ review, pr }],
					closedPRs: [pr],
				}),
			);

			const source = await createSource(
				['pull_request.review_submitted', 'pull_request.closed'],
				mock,
			);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(2);
			expect(mockExecuteBatchPRQuery).toHaveBeenCalledTimes(1);
		});
	});

	describe('shutdown', () => {
		it('completes without error', async () => {
			const source = new GitHubSource();
			await expect(source.shutdown()).resolves.toBeUndefined();
		});
	});
});
