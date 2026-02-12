/**
 * GitHub source connector — polls GitHub API for repository events.
 *
 * Uses octokit.paginate() for all list endpoints to avoid data loss
 * from silent truncation at page boundaries.
 *
 * Rate limit awareness: reads X-RateLimit-Remaining/Reset headers,
 * warns when low, pauses when exhausted. Initial sync defaults to a
 * configurable lookback window (default 7d) instead of epoch to avoid
 * burning through the 5000 req/hr limit on large repos.
 */

import { Octokit } from '@octokit/rest';
import type { OrgLoopEvent, PollResult, SourceConfig, SourceConnector } from '@orgloop/sdk';
import { parseDuration } from '@orgloop/sdk';
import {
	normalizeCheckSuiteCompleted,
	normalizeIssueComment,
	normalizePullRequestClosed,
	normalizePullRequestOpened,
	normalizePullRequestReadyForReview,
	normalizePullRequestReview,
	normalizePullRequestReviewComment,
	normalizeWorkflowRunFailed,
} from './normalizer.js';

/** Resolve env var references like ${GITHUB_TOKEN} */
function resolveEnvVar(value: string): string {
	const match = value.match(/^\$\{(.+)\}$/);
	if (match) {
		const envValue = process.env[match[1]];
		if (!envValue) {
			throw new Error(`Environment variable ${match[1]} is not set`);
		}
		return envValue;
	}
	return value;
}

/** Default lookback window for initial sync (no checkpoint) */
const DEFAULT_INITIAL_LOOKBACK = '7d';

/** Epoch threshold — checkpoints at or before this are treated as "no checkpoint" */
const EPOCH_THRESHOLD = '1970-01-02T00:00:00.000Z';

/** Remaining rate limit requests before we start warning */
const RATE_LIMIT_WARN_THRESHOLD = 100;

interface GitHubSourceConfig {
	repo: string; // "owner/repo"
	events: string[];
	authors?: string[];
	token: string;
	/** How far back to look on initial sync (e.g. "7d", "24h"). Default: 7d */
	initial_lookback?: string;
}

type GitHubPull = Record<string, unknown>;

/** Rate limit state tracked from API response headers */
interface RateLimitState {
	remaining: number;
	resetAt: Date;
}

export class GitHubSource implements SourceConnector {
	readonly id = 'github';
	private octokit!: Octokit;
	private owner = '';
	private repo = '';
	private events: string[] = [];
	private authors: string[] = [];
	private sourceId = '';
	private initialLookbackMs = parseDuration(DEFAULT_INITIAL_LOOKBACK);
	private rateLimit: RateLimitState | null = null;

	async init(config: SourceConfig): Promise<void> {
		const cfg = config.config as unknown as GitHubSourceConfig;
		const [owner, repo] = cfg.repo.split('/');
		this.owner = owner;
		this.repo = repo;
		this.events = cfg.events ?? [];
		this.authors = cfg.authors ?? [];
		this.sourceId = config.id;

		if (cfg.initial_lookback) {
			this.initialLookbackMs = parseDuration(cfg.initial_lookback);
		}

		const token = resolveEnvVar(cfg.token);
		this.octokit = new Octokit({ auth: token });
	}

	async poll(checkpoint: string | null): Promise<PollResult> {
		// Apply initial lookback window when no checkpoint exists or checkpoint is epoch
		const isEpochCheckpoint = checkpoint != null && checkpoint <= EPOCH_THRESHOLD;
		const since =
			checkpoint && !isEpochCheckpoint
				? new Date(checkpoint).toISOString()
				: new Date(Date.now() - this.initialLookbackMs).toISOString();
		const events: OrgLoopEvent[] = [];
		let latestTimestamp = since;

		try {
			// Check rate limit before starting
			await this.checkRateLimit();

			// Fetch PRs once for methods that need them (reviews + review comments)
			const needsPulls =
				this.events.includes('pull_request.review_submitted') ||
				this.events.includes('pull_request_review_comment');

			let pulls: GitHubPull[] = [];
			if (needsPulls) {
				pulls = await this.fetchUpdatedPulls(since);
			}

			if (this.events.includes('pull_request.review_submitted')) {
				const reviews = await this.pollReviews(since, pulls);
				events.push(...reviews);
			}

			if (this.events.includes('pull_request_review_comment')) {
				const comments = await this.pollReviewComments(since, pulls);
				events.push(...comments);
			}

			if (this.events.includes('issue_comment')) {
				const comments = await this.pollIssueComments(since);
				events.push(...comments);
			}

			if (
				this.events.includes('pull_request.closed') ||
				this.events.includes('pull_request.merged')
			) {
				const prs = await this.pollClosedPRs(since);
				events.push(...prs);
			}

			if (this.events.includes('pull_request.opened')) {
				const prs = await this.pollOpenedPRs(since);
				events.push(...prs);
			}

			if (this.events.includes('pull_request.ready_for_review')) {
				const prs = await this.pollReadyForReviewPRs(since);
				events.push(...prs);
			}

			if (this.events.includes('workflow_run.completed')) {
				const runs = await this.pollFailedWorkflowRuns(since);
				events.push(...runs);
			}

			if (this.events.includes('check_suite.completed')) {
				const suites = await this.pollCheckSuites(since);
				events.push(...suites);
			}
		} catch (err: unknown) {
			const error = err as {
				status?: number;
				message?: string;
				response?: { headers?: Record<string, string> };
			};

			// Update rate limit state from error response if available
			if (error.response?.headers) {
				this.updateRateLimitFromHeaders(error.response.headers);
			}

			if (error.status === 429 || (error.status === 403 && this.isRateLimited())) {
				const resetInfo = this.rateLimit
					? ` Resets at ${this.rateLimit.resetAt.toISOString()}`
					: '';
				console.warn(`[github] Rate limited.${resetInfo} Returning partial results.`);
				// Return what we have so far with current checkpoint
				return {
					events: this.filterByAuthors(events),
					checkpoint: this.advanceCheckpoint(events, latestTimestamp),
				};
			}
			if (error.status === 401 || error.status === 403) {
				console.error(`[github] Auth error: ${error.message}`);
				return { events: [], checkpoint: latestTimestamp };
			}
			throw err;
		}

		// Find the latest timestamp among all events
		latestTimestamp = this.advanceCheckpoint(events, latestTimestamp);

		return { events: this.filterByAuthors(events), checkpoint: latestTimestamp };
	}

	/**
	 * Update rate limit state from response headers.
	 */
	private updateRateLimitFromHeaders(headers: Record<string, string>): void {
		const remaining = headers['x-ratelimit-remaining'];
		const reset = headers['x-ratelimit-reset'];
		if (remaining != null && reset != null) {
			this.rateLimit = {
				remaining: Number.parseInt(remaining, 10),
				resetAt: new Date(Number.parseInt(reset, 10) * 1000),
			};
		}
	}

	/**
	 * Check rate limit state and wait if exhausted, warn if low.
	 */
	private async checkRateLimit(): Promise<void> {
		if (!this.rateLimit) return;

		if (this.rateLimit.remaining === 0) {
			const waitMs = this.rateLimit.resetAt.getTime() - Date.now();
			if (waitMs > 0) {
				console.warn(
					`[github] Rate limit exhausted. Waiting ${Math.ceil(waitMs / 1000)}s until ${this.rateLimit.resetAt.toISOString()}`,
				);
				await new Promise((resolve) => setTimeout(resolve, waitMs));
			}
		} else if (this.rateLimit.remaining <= RATE_LIMIT_WARN_THRESHOLD) {
			console.warn(
				`[github] Rate limit low: ${this.rateLimit.remaining} requests remaining. Resets at ${this.rateLimit.resetAt.toISOString()}`,
			);
		}
	}

	/**
	 * Check if the current state indicates a rate limit (remaining === 0).
	 */
	private isRateLimited(): boolean {
		return this.rateLimit !== null && this.rateLimit.remaining === 0;
	}

	/**
	 * Advance checkpoint to the latest event timestamp.
	 */
	private advanceCheckpoint(events: OrgLoopEvent[], fallback: string): string {
		let latest = fallback;
		for (const event of events) {
			if (event.timestamp > latest) {
				latest = event.timestamp;
			}
		}
		return latest;
	}

	/**
	 * Filter events by configured authors.
	 */
	private filterByAuthors(events: OrgLoopEvent[]): OrgLoopEvent[] {
		if (this.authors.length === 0) return events;
		return events.filter((e) => this.authors.includes(e.provenance.author ?? ''));
	}

	/**
	 * Fetch recently-updated PRs using pagination with early termination.
	 * Stops fetching pages once PRs are older than the since cutoff.
	 */
	private async fetchUpdatedPulls(since: string): Promise<GitHubPull[]> {
		const result: GitHubPull[] = [];

		// Use manual pagination with early termination to avoid fetching
		// all PRs in repos with thousands of them
		const iterator = this.octokit.paginate.iterator(this.octokit.pulls.list, {
			owner: this.owner,
			repo: this.repo,
			state: 'all',
			sort: 'updated',
			direction: 'desc',
			per_page: 100,
		});

		for await (const response of iterator) {
			// Track rate limit from each response
			if (response.headers) {
				this.updateRateLimitFromHeaders(response.headers as unknown as Record<string, string>);
			}

			const pulls = response.data as unknown as GitHubPull[];
			let allOlderThanSince = true;

			for (const pr of pulls) {
				if (pr.updated_at && (pr.updated_at as string) >= since) {
					result.push(pr);
					allOlderThanSince = false;
				}
			}

			// If every PR on this page is older than `since`, no need to fetch more
			if (allOlderThanSince && pulls.length > 0) {
				break;
			}
		}

		return result;
	}

	private async pollReviews(since: string, pulls: GitHubPull[]): Promise<OrgLoopEvent[]> {
		const events: OrgLoopEvent[] = [];
		const repoData = { full_name: `${this.owner}/${this.repo}` };

		for (const pr of pulls) {
			// Check rate limit before each per-PR API call
			await this.checkRateLimit();

			try {
				const reviews = await this.octokit.paginate(this.octokit.pulls.listReviews, {
					owner: this.owner,
					repo: this.repo,
					pull_number: pr.number as number,
					per_page: 100,
				});
				for (const review of reviews) {
					const submitted = (review as unknown as Record<string, unknown>).submitted_at as
						| string
						| undefined;
					if (submitted && submitted > since) {
						events.push(
							normalizePullRequestReview(
								this.sourceId,
								review as unknown as Record<string, unknown>,
								pr,
								repoData,
							),
						);
					}
				}
			} catch {
				// Skip individual PR errors
			}
		}
		return events;
	}

	private async pollReviewComments(since: string, pulls: GitHubPull[]): Promise<OrgLoopEvent[]> {
		const events: OrgLoopEvent[] = [];
		const repoData = { full_name: `${this.owner}/${this.repo}` };

		for (const pr of pulls) {
			await this.checkRateLimit();

			try {
				const comments = await this.octokit.paginate(this.octokit.pulls.listReviewComments, {
					owner: this.owner,
					repo: this.repo,
					pull_number: pr.number as number,
					since,
					per_page: 100,
				});
				for (const comment of comments) {
					const updatedAt = (comment as unknown as Record<string, unknown>).updated_at as string;
					if (updatedAt > since) {
						events.push(
							normalizePullRequestReviewComment(
								this.sourceId,
								comment as unknown as Record<string, unknown>,
								pr,
								repoData,
							),
						);
					}
				}
			} catch {
				// Skip individual PR errors
			}
		}
		return events;
	}

	private async pollIssueComments(since: string): Promise<OrgLoopEvent[]> {
		const comments = await this.octokit.paginate(this.octokit.issues.listCommentsForRepo, {
			owner: this.owner,
			repo: this.repo,
			since,
			sort: 'updated',
			direction: 'desc',
			per_page: 100,
		});

		const repoData = { full_name: `${this.owner}/${this.repo}` };
		return (comments as unknown as Record<string, unknown>[])
			.filter((c) => (c.updated_at as string) > since)
			.map((comment) => {
				const issueNumber = (comment.issue_url as string)?.split('/').pop();
				return normalizeIssueComment(
					this.sourceId,
					comment,
					{ number: Number(issueNumber), title: '' },
					repoData,
				);
			});
	}

	private async pollClosedPRs(since: string): Promise<OrgLoopEvent[]> {
		const events: OrgLoopEvent[] = [];
		const repoData = { full_name: `${this.owner}/${this.repo}` };

		const iterator = this.octokit.paginate.iterator(this.octokit.pulls.list, {
			owner: this.owner,
			repo: this.repo,
			state: 'closed',
			sort: 'updated',
			direction: 'desc',
			per_page: 100,
		});

		for await (const response of iterator) {
			if (response.headers) {
				this.updateRateLimitFromHeaders(response.headers as unknown as Record<string, string>);
			}

			const pulls = response.data as unknown as GitHubPull[];
			let allOlderThanSince = true;

			for (const pr of pulls) {
				if (pr.updated_at && (pr.updated_at as string) >= since) {
					allOlderThanSince = false;
					if (pr.closed_at && (pr.closed_at as string) > since) {
						events.push(normalizePullRequestClosed(this.sourceId, pr, repoData));
					}
				}
			}

			if (allOlderThanSince && pulls.length > 0) {
				break;
			}
		}

		return events;
	}

	private async pollOpenedPRs(since: string): Promise<OrgLoopEvent[]> {
		const events: OrgLoopEvent[] = [];
		const repoData = { full_name: `${this.owner}/${this.repo}` };

		const iterator = this.octokit.paginate.iterator(this.octokit.pulls.list, {
			owner: this.owner,
			repo: this.repo,
			state: 'open',
			sort: 'created',
			direction: 'desc',
			per_page: 100,
		});

		for await (const response of iterator) {
			if (response.headers) {
				this.updateRateLimitFromHeaders(response.headers as unknown as Record<string, string>);
			}

			const pulls = response.data as unknown as GitHubPull[];
			let allOlderThanSince = true;

			for (const pr of pulls) {
				if (pr.created_at && (pr.created_at as string) >= since) {
					allOlderThanSince = false;
					if ((pr.created_at as string) > since) {
						events.push(normalizePullRequestOpened(this.sourceId, pr, repoData));
					}
				}
			}

			if (allOlderThanSince && pulls.length > 0) {
				break;
			}
		}

		return events;
	}

	private async pollReadyForReviewPRs(since: string): Promise<OrgLoopEvent[]> {
		const events: OrgLoopEvent[] = [];
		const repoData = { full_name: `${this.owner}/${this.repo}` };

		const iterator = this.octokit.paginate.iterator(this.octokit.pulls.list, {
			owner: this.owner,
			repo: this.repo,
			state: 'open',
			sort: 'updated',
			direction: 'desc',
			per_page: 100,
		});

		for await (const response of iterator) {
			if (response.headers) {
				this.updateRateLimitFromHeaders(response.headers as unknown as Record<string, string>);
			}

			const pulls = response.data as unknown as GitHubPull[];
			let allOlderThanSince = true;

			for (const pr of pulls) {
				if (pr.updated_at && (pr.updated_at as string) >= since) {
					allOlderThanSince = false;
					if (pr.draft === false && (pr.updated_at as string) > since) {
						events.push(normalizePullRequestReadyForReview(this.sourceId, pr, repoData));
					}
				}
			}

			if (allOlderThanSince && pulls.length > 0) {
				break;
			}
		}

		return events;
	}

	private async pollFailedWorkflowRuns(since: string): Promise<OrgLoopEvent[]> {
		const events: OrgLoopEvent[] = [];
		const repoData = { full_name: `${this.owner}/${this.repo}` };

		const iterator = this.octokit.paginate.iterator(this.octokit.actions.listWorkflowRunsForRepo, {
			owner: this.owner,
			repo: this.repo,
			status: 'failure' as const,
			per_page: 100,
		});

		for await (const response of iterator) {
			if (response.headers) {
				this.updateRateLimitFromHeaders(response.headers as unknown as Record<string, string>);
			}

			const runs = response.data as unknown as Record<string, unknown>[];
			let allOlderThanSince = true;

			for (const run of runs) {
				if (run.updated_at && (run.updated_at as string) >= since) {
					allOlderThanSince = false;
					if ((run.updated_at as string) > since) {
						events.push(normalizeWorkflowRunFailed(this.sourceId, run, repoData));
					}
				}
			}

			if (allOlderThanSince && runs.length > 0) {
				break;
			}
		}

		return events;
	}

	private async pollCheckSuites(since: string): Promise<OrgLoopEvent[]> {
		const { data } = await this.octokit.checks.listSuitesForRef({
			owner: this.owner,
			repo: this.repo,
			ref: 'HEAD',
			per_page: 100,
		});

		const repoData = { full_name: `${this.owner}/${this.repo}` };
		return (data.check_suites as unknown as Record<string, unknown>[])
			.filter(
				(suite) =>
					(suite.status as string) === 'completed' &&
					suite.updated_at &&
					(suite.updated_at as string) > since,
			)
			.map((suite) => normalizeCheckSuiteCompleted(this.sourceId, suite, repoData));
	}

	async shutdown(): Promise<void> {
		// Nothing to clean up
	}
}
