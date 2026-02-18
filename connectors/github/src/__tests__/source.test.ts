/**
 * Tests for GitHubSource polling logic.
 * Mocks Octokit to test all polling methods, pagination, dedup, error handling,
 * rate limiting, and initial lookback window.
 */

import { GitHubSource } from '../source.js';

// ─── Mock Octokit ────────────────────────────────────────────────────────────

function createMockOctokit() {
	const pulls = {
		list: vi.fn(),
		get: vi.fn(),
		listReviews: vi.fn(),
		listReviewComments: vi.fn(),
		listReviewCommentsForRepo: vi.fn(),
	};
	const issues = {
		listCommentsForRepo: vi.fn(),
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
		// For paginate, return the data array directly (Octokit paginate unwraps)
		if (Array.isArray(result.data)) {
			return result.data;
		}
		// For endpoints that nest (e.g., workflow_runs), paginate flattens
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

	// paginate.iterator — yields pages of {data, headers}
	// Used by fetchUpdatedPulls, pollClosedPRs, pollOpenedPRs, pollReadyForReviewPRs,
	// pollFailedWorkflowRuns
	paginate.iterator = vi.fn((endpoint: unknown, params: unknown) => {
		// Default: call the endpoint once and yield result as a single page
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

// ─── Setup ───────────────────────────────────────────────────────────────────

async function createSource(
	events: string[],
	mockOctokit: ReturnType<typeof createMockOctokit>,
	opts?: { authors?: string[]; initial_lookback?: string },
) {
	const source = new GitHubSource();
	// Use init to set up internal state, then override the octokit instance
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
	// Replace the real octokit with mock
	(source as unknown as Record<string, unknown>).octokit = mockOctokit;
	return source;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GitHubSource', () => {
	afterEach(() => {
		process.env.GITHUB_TOKEN = undefined;
		vi.restoreAllMocks();
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

	describe('pollReviews', () => {
		it('fetches PRs with pagination and returns review events', async () => {
			const mock = createMockOctokit();
			const pr = makePR({ number: 1 });
			const review = makeReview({ submitted_at: '2024-01-15T10:00:00Z' });

			mock.pulls.list.mockResolvedValue({ data: [pr] });
			mock.pulls.listReviews.mockResolvedValue({ data: [review] });

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('pull_request.review_submitted');
			expect(result.events[0].payload.review_state).toBe('approved');
			expect(result.events[0].provenance.author).toBe('bob');
			// paginate.iterator was called for fetchUpdatedPulls
			expect(mock.paginate.iterator).toHaveBeenCalled();
		});

		it('filters out reviews older than checkpoint', async () => {
			const mock = createMockOctokit();
			const pr = makePR({ number: 1 });
			const oldReview = makeReview({ submitted_at: '2024-01-14T08:00:00Z' });
			const newReview = makeReview({
				submitted_at: '2024-01-15T10:00:00Z',
				id: 101,
			});

			mock.pulls.list.mockResolvedValue({ data: [pr] });
			mock.pulls.listReviews.mockResolvedValue({ data: [oldReview, newReview] });

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
		});

		it('handles multiple PRs with reviews', async () => {
			const mock = createMockOctokit();
			const pr1 = makePR({ number: 1 });
			const pr2 = makePR({ number: 2, title: 'PR 2' });
			const review1 = makeReview({ submitted_at: '2024-01-15T10:00:00Z' });
			const review2 = makeReview({
				submitted_at: '2024-01-15T11:00:00Z',
				id: 102,
			});

			mock.pulls.list.mockResolvedValue({ data: [pr1, pr2] });
			mock.pulls.listReviews
				.mockResolvedValueOnce({ data: [review1] })
				.mockResolvedValueOnce({ data: [review2] });

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(2);
		});

		it('skips individual PR errors without failing', async () => {
			const mock = createMockOctokit();
			const pr1 = makePR({ number: 1 });
			const pr2 = makePR({ number: 2 });

			mock.pulls.list.mockResolvedValue({ data: [pr1, pr2] });
			mock.pulls.listReviews.mockRejectedValueOnce(new Error('Not found')).mockResolvedValueOnce({
				data: [makeReview({ submitted_at: '2024-01-15T10:00:00Z' })],
			});

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
		});
	});

	describe('pollReviewComments', () => {
		it('returns review comment events with pagination', async () => {
			const mock = createMockOctokit();
			const pr = makePR();
			const comment = makeReviewComment();

			mock.pulls.list.mockResolvedValue({ data: [pr] });
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
			// No PRs returned by fetchUpdatedPulls (simulates PR not in recent cache)
			mock.pulls.list.mockResolvedValue({ data: [] });

			// Comment references PR #42 which isn't in the pulls list
			const comment = makeReviewComment({
				pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/42',
			});
			mock.pulls.listReviewCommentsForRepo.mockResolvedValue({ data: [comment] });

			// pulls.get returns the full PR with user data
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
			mock.pulls.list.mockResolvedValue({ data: [] });

			// Two comments on the same uncached PR #42
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
			// Both events should have the correct pr_author
			expect(result.events[0].provenance.pr_author).toBe('alice');
			expect(result.events[1].provenance.pr_author).toBe('alice');
			// pulls.get should only have been called once (cached for second comment)
			expect(mock.pulls.get).toHaveBeenCalledTimes(1);
		});

		it('falls back to unknown pr_author when fetch fails', async () => {
			const mock = createMockOctokit();
			mock.pulls.list.mockResolvedValue({ data: [] });

			const comment = makeReviewComment({
				pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/99',
			});
			mock.pulls.listReviewCommentsForRepo.mockResolvedValue({ data: [comment] });

			// Simulate API failure
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

	describe('PR dedup — shared pulls.list', () => {
		it('calls paginate.iterator only once when both reviews and comments are subscribed', async () => {
			const mock = createMockOctokit();
			const pr = makePR();
			const review = makeReview({ submitted_at: '2024-01-15T10:00:00Z' });
			const comment = makeReviewComment();

			mock.pulls.list.mockResolvedValue({ data: [pr] });
			mock.pulls.listReviews.mockResolvedValue({ data: [review] });
			mock.pulls.listReviewCommentsForRepo.mockResolvedValue({ data: [comment] });

			const source = await createSource(
				['pull_request.review_submitted', 'pull_request_review_comment'],
				mock,
			);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(2);
			// paginate.iterator should have been called only once (for fetchUpdatedPulls)
			expect(mock.paginate.iterator).toHaveBeenCalledTimes(1);
		});
	});

	describe('pollIssueComments', () => {
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

	describe('pollClosedPRs', () => {
		it('returns closed PR events', async () => {
			const mock = createMockOctokit();
			const pr = makePR({
				state: 'closed',
				closed_at: '2024-01-15T10:00:00Z',
				merged: false,
			});

			mock.pulls.list.mockResolvedValue({ data: [pr] });

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

			mock.pulls.list.mockResolvedValue({ data: [pr] });

			const source = await createSource(['pull_request.merged'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('pull_request.merged');
			expect(result.events[0].payload.merged_by).toBe('bob');
		});
	});

	describe('pollOpenedPRs (new event)', () => {
		it('returns opened PR events', async () => {
			const mock = createMockOctokit();
			const pr = makePR({ created_at: '2024-01-15T10:00:00Z' });

			mock.pulls.list.mockResolvedValue({ data: [pr] });

			const source = await createSource(['pull_request.opened'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('pull_request.opened');
			expect(result.events[0].payload.action).toBe('opened');
			expect(result.events[0].payload.head_ref).toBe('feature-branch');
			expect(result.events[0].payload.base_ref).toBe('main');
		});

		it('filters out PRs created before checkpoint', async () => {
			const mock = createMockOctokit();
			const pr = makePR({ created_at: '2024-01-14T08:00:00Z' });

			mock.pulls.list.mockResolvedValue({ data: [pr] });

			const source = await createSource(['pull_request.opened'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(0);
		});
	});

	describe('pollReadyForReviewPRs (new event)', () => {
		it('returns non-draft PRs updated after checkpoint', async () => {
			const mock = createMockOctokit();
			const pr = makePR({
				draft: false,
				updated_at: '2024-01-15T10:00:00Z',
			});

			mock.pulls.list.mockResolvedValue({ data: [pr] });

			const source = await createSource(['pull_request.ready_for_review'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('pull_request.ready_for_review');
			expect(result.events[0].payload.action).toBe('ready_for_review');
		});

		it('excludes draft PRs', async () => {
			const mock = createMockOctokit();
			const pr = makePR({
				draft: true,
				updated_at: '2024-01-15T10:00:00Z',
			});

			mock.pulls.list.mockResolvedValue({ data: [pr] });

			const source = await createSource(['pull_request.ready_for_review'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(0);
		});
	});

	describe('pollFailedWorkflowRuns', () => {
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

	describe('pollCheckSuites (new event)', () => {
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

	describe('error handling', () => {
		it('returns empty events on rate limit (429)', async () => {
			const mock = createMockOctokit();
			const error = Object.assign(new Error('rate limited'), { status: 429 });

			mock.pulls.list.mockRejectedValue(error);
			mock.paginate.mockRejectedValue(error);
			mock.paginate.iterator.mockReturnValue({
				// biome-ignore lint/correctness/useYield: mock iterator that throws before yielding
				async *[Symbol.asyncIterator]() {
					throw error;
				},
			});

			const source = await createSource(['pull_request.review_submitted'], mock);
			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(0);
			consoleSpy.mockRestore();
		});

		it('returns empty events on auth error (401)', async () => {
			const mock = createMockOctokit();
			const error = Object.assign(new Error('Bad credentials'), { status: 401 });

			mock.pulls.list.mockRejectedValue(error);
			mock.paginate.mockRejectedValue(error);
			mock.paginate.iterator.mockReturnValue({
				// biome-ignore lint/correctness/useYield: mock iterator that throws before yielding
				async *[Symbol.asyncIterator]() {
					throw error;
				},
			});

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

			mock.pulls.list.mockRejectedValue(error);
			mock.paginate.mockRejectedValue(error);
			mock.paginate.iterator.mockReturnValue({
				// biome-ignore lint/correctness/useYield: mock iterator that throws before yielding
				async *[Symbol.asyncIterator]() {
					throw error;
				},
			});

			const source = await createSource(['pull_request.review_submitted'], mock);
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(0);
			consoleSpy.mockRestore();
		});

		it('rethrows non-HTTP errors', async () => {
			const mock = createMockOctokit();
			const error = new Error('Network failure');

			mock.pulls.list.mockRejectedValue(error);
			mock.paginate.mockRejectedValue(error);
			mock.paginate.iterator.mockReturnValue({
				// biome-ignore lint/correctness/useYield: mock iterator that throws before yielding
				async *[Symbol.asyncIterator]() {
					throw error;
				},
			});

			const source = await createSource(['pull_request.review_submitted'], mock);
			await expect(source.poll('2024-01-15T09:00:00Z')).rejects.toThrow('Network failure');
		});
	});

	describe('author filtering', () => {
		it('filters events by author when authors config is set', async () => {
			const mock = createMockOctokit();
			const pr = makePR();
			const reviewByAlice = makeReview({
				submitted_at: '2024-01-15T10:00:00Z',
				user: { login: 'alice', type: 'User' },
			});
			const reviewByBob = makeReview({
				submitted_at: '2024-01-15T10:00:00Z',
				user: { login: 'bob', type: 'User' },
				id: 101,
			});

			mock.pulls.list.mockResolvedValue({ data: [pr] });
			mock.pulls.listReviews.mockResolvedValue({
				data: [reviewByAlice, reviewByBob],
			});

			const source = await createSource(['pull_request.review_submitted'], mock, {
				authors: ['bob'],
			});
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.author).toBe('bob');
		});

		it('returns all events when no authors filter', async () => {
			const mock = createMockOctokit();
			const pr = makePR();
			const review1 = makeReview({
				submitted_at: '2024-01-15T10:00:00Z',
				user: { login: 'alice', type: 'User' },
			});
			const review2 = makeReview({
				submitted_at: '2024-01-15T10:00:00Z',
				user: { login: 'bob', type: 'User' },
				id: 101,
			});

			mock.pulls.list.mockResolvedValue({ data: [pr] });
			mock.pulls.listReviews.mockResolvedValue({ data: [review1, review2] });

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(2);
		});
	});

	describe('checkpoint advancement', () => {
		it('advances checkpoint to latest event timestamp', async () => {
			const mock = createMockOctokit();
			const pr = makePR();
			const review1 = makeReview({ submitted_at: '2024-01-15T10:00:00Z' });
			const review2 = makeReview({
				submitted_at: '2024-01-15T12:00:00Z',
				id: 101,
			});

			mock.pulls.list.mockResolvedValue({ data: [pr] });
			mock.pulls.listReviews.mockResolvedValue({ data: [review1, review2] });

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			// Checkpoint should be the latest event's timestamp
			expect(result.checkpoint > '2024-01-15T09:00:00Z').toBe(true);
		});

		it('returns lookback-based checkpoint when no prior checkpoint and no events', async () => {
			const mock = createMockOctokit();
			mock.pulls.list.mockResolvedValue({ data: [] });

			const source = await createSource(['pull_request.review_submitted'], mock);
			const before = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
			const result = await source.poll(null);

			expect(result.events).toHaveLength(0);
			// Checkpoint should be approximately 7 days ago, not epoch
			expect(result.checkpoint > '2020-01-01T00:00:00Z').toBe(true);
			// Should be within a few seconds of the 7-day lookback
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

			mock.pulls.list.mockResolvedValue({ data: [pr] });
			mock.pulls.listReviews.mockResolvedValue({ data: [review] });

			const source = await createSource(['pull_request.review_submitted'], mock);
			const result = await source.poll(null);

			// Should return the recent event (within 7d lookback)
			expect(result.events).toHaveLength(1);
		});

		it('respects custom initial_lookback config', async () => {
			const mock = createMockOctokit();
			// PR from 2 days ago — within 3d lookback but outside 1d
			const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
			const pr = makePR({ updated_at: twoDaysAgo });
			const review = makeReview({ submitted_at: twoDaysAgo });

			mock.pulls.list.mockResolvedValue({ data: [pr] });
			mock.pulls.listReviews.mockResolvedValue({ data: [review] });

			// With 1d lookback, the 2-day-old review should be filtered out
			const source1d = await createSource(['pull_request.review_submitted'], mock, {
				initial_lookback: '1d',
			});
			const result1d = await source1d.poll(null);
			expect(result1d.events).toHaveLength(0);

			// With 3d lookback, it should be included
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

			mock.pulls.list.mockResolvedValue({ data: [pr] });
			mock.pulls.listReviews.mockResolvedValue({ data: [review] });

			const source = await createSource(['pull_request.review_submitted'], mock);
			// Explicit checkpoint from months ago — should use it, not lookback
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

			mock.pulls.list.mockResolvedValue({ data: [pr] });
			mock.pulls.listReviews.mockResolvedValue({ data: [review] });

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

			mock.pulls.list.mockResolvedValue({ data: [pr] });
			mock.pulls.listReviews.mockResolvedValue({ data: [botReview] });

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

			mock.pulls.list.mockResolvedValue({ data: [pr] });
			mock.pulls.listReviews.mockResolvedValue({ data: [review] });

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
		it('returns partial results when rate limited mid-poll (429)', async () => {
			const mock = createMockOctokit();
			const comment = makeIssueComment();
			const rateLimitError = Object.assign(new Error('rate limited'), {
				status: 429,
				response: {
					headers: {
						'x-ratelimit-remaining': '0',
						'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
					},
				},
			});

			// issue_comment succeeds via paginate(), then closedPRs throws 429 via iterator
			mock.issues.listCommentsForRepo.mockResolvedValue({ data: [comment] });
			mock.paginate.mockResolvedValueOnce([comment]); // issue comments
			// pollClosedPRs now uses paginate.iterator — override it to throw
			mock.paginate.iterator.mockImplementation(() => {
				return {
					// biome-ignore lint/correctness/useYield: mock iterator that throws before yielding
					async *[Symbol.asyncIterator]() {
						throw rateLimitError;
					},
				};
			});

			const source = await createSource(['issue_comment', 'pull_request.closed'], mock);
			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const result = await source.poll('2024-01-15T09:00:00Z');

			// Should have returned the issue comment events collected before the error
			expect(result.events.length).toBeGreaterThanOrEqual(1);
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[github] Rate limited.'));
			consoleSpy.mockRestore();
		});

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

			mock.pulls.list.mockRejectedValue(rateLimitError);
			mock.paginate.iterator.mockReturnValue({
				// biome-ignore lint/correctness/useYield: mock iterator that throws before yielding
				async *[Symbol.asyncIterator]() {
					throw rateLimitError;
				},
			});

			const source = await createSource(['pull_request.review_submitted'], mock);
			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(result.events).toHaveLength(0);
			// Should warn about rate limit, NOT log auth error
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Rate limited'));
			expect(errorSpy).not.toHaveBeenCalled();
			consoleSpy.mockRestore();
			errorSpy.mockRestore();
		});

		it('warns when rate limit is low', async () => {
			const mock = createMockOctokit();
			const pr = makePR();
			const review = makeReview({ submitted_at: '2024-01-15T10:00:00Z' });

			mock.pulls.list.mockResolvedValue({ data: [pr] });
			mock.pulls.listReviews.mockResolvedValue({ data: [review] });

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
			// PR from 30 days ago — outside 7d lookback
			const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
			const pr = makePR({ updated_at: oldDate });
			const review = makeReview({ submitted_at: oldDate });

			mock.pulls.list.mockResolvedValue({ data: [pr] });
			mock.pulls.listReviews.mockResolvedValue({ data: [review] });

			const source = await createSource(['pull_request.review_submitted'], mock);
			// Epoch checkpoint should trigger lookback, filtering out the 30-day-old event
			const result = await source.poll('1970-01-01T00:00:00.000Z');

			expect(result.events).toHaveLength(0);
			// Checkpoint should be ~7 days ago, not epoch
			expect(result.checkpoint > '2020-01-01T00:00:00Z').toBe(true);
		});

		it('applies lookback window when checkpoint is epoch (zero)', async () => {
			const mock = createMockOctokit();
			const recentDate = new Date().toISOString();
			const pr = makePR({ updated_at: recentDate });
			const review = makeReview({ submitted_at: recentDate });

			mock.pulls.list.mockResolvedValue({ data: [pr] });
			mock.pulls.listReviews.mockResolvedValue({ data: [review] });

			const source = await createSource(['pull_request.review_submitted'], mock);
			// Epoch checkpoint — recent events should still be returned via lookback
			const result = await source.poll('1970-01-01T00:00:00.000Z');

			expect(result.events).toHaveLength(1);
		});
	});

	describe('fetchUpdatedPulls early termination', () => {
		it('stops paginating when all PRs on a page are older than since', async () => {
			const mock = createMockOctokit();
			const recentPR = makePR({
				number: 1,
				updated_at: '2024-01-15T10:00:00Z',
			});
			const oldPR = makePR({
				number: 2,
				updated_at: '2024-01-10T10:00:00Z',
			});

			let pageCount = 0;
			mock.paginate.iterator.mockReturnValue({
				async *[Symbol.asyncIterator]() {
					pageCount++;
					yield { data: [recentPR], headers: {} };
					pageCount++;
					// Second page: all old PRs — should stop here
					yield { data: [oldPR], headers: {} };
					pageCount++;
					// Third page: should never be reached
					yield { data: [oldPR], headers: {} };
				},
			});
			mock.pulls.listReviews.mockResolvedValue({ data: [] });

			const source = await createSource(['pull_request.review_submitted'], mock);
			await source.poll('2024-01-15T09:00:00Z');

			// Should have only fetched 2 pages (stopped after finding all-old page)
			expect(pageCount).toBe(2);
		});
	});

	describe('pagination early-exit for poll methods', () => {
		it('pollClosedPRs stops paginating when all PRs on a page are older than since', async () => {
			const mock = createMockOctokit();
			const recentPR = makePR({
				number: 1,
				state: 'closed',
				updated_at: '2024-01-15T10:00:00Z',
				closed_at: '2024-01-15T10:00:00Z',
			});
			const oldPR = makePR({
				number: 2,
				state: 'closed',
				updated_at: '2024-01-10T10:00:00Z',
				closed_at: '2024-01-10T10:00:00Z',
			});

			let pageCount = 0;
			mock.paginate.iterator.mockReturnValue({
				async *[Symbol.asyncIterator]() {
					pageCount++;
					yield { data: [recentPR], headers: {} };
					pageCount++;
					yield { data: [oldPR], headers: {} };
					pageCount++;
					// Should never reach here
					yield { data: [oldPR], headers: {} };
				},
			});

			const source = await createSource(['pull_request.closed'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(pageCount).toBe(2);
			expect(result.events).toHaveLength(1);
		});

		it('pollOpenedPRs stops paginating when all PRs on a page are older than since', async () => {
			const mock = createMockOctokit();
			const recentPR = makePR({
				number: 1,
				created_at: '2024-01-15T10:00:00Z',
				updated_at: '2024-01-15T10:00:00Z',
			});
			const oldPR = makePR({
				number: 2,
				created_at: '2024-01-10T10:00:00Z',
				updated_at: '2024-01-10T10:00:00Z',
			});

			let pageCount = 0;
			mock.paginate.iterator.mockReturnValue({
				async *[Symbol.asyncIterator]() {
					pageCount++;
					yield { data: [recentPR], headers: {} };
					pageCount++;
					yield { data: [oldPR], headers: {} };
					pageCount++;
					yield { data: [oldPR], headers: {} };
				},
			});

			const source = await createSource(['pull_request.opened'], mock);
			const result = await source.poll('2024-01-15T09:00:00Z');

			expect(pageCount).toBe(2);
			expect(result.events).toHaveLength(1);
		});

		it('pollFailedWorkflowRuns stops paginating when all runs on a page are older than since', async () => {
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

	describe('shutdown', () => {
		it('completes without error', async () => {
			const source = new GitHubSource();
			await expect(source.shutdown()).resolves.toBeUndefined();
		});
	});
});
