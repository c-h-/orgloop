/**
 * GitHub source connector — polls GitHub API for repository events.
 *
 * Smart polling strategy (WQ-94):
 * - Repo-level endpoints for review comments (replaces per-PR scraping)
 * - Local PR state cache (skip unchanged PRs for reviews)
 * - Rate budget awareness (skip non-essential events when budget low)
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

/** Minimum budget to continue fetching non-essential event types */
const RATE_BUDGET_MIN_THRESHOLD = 50;

/** Evict cached PR entries older than 30 days */
const PR_CACHE_EVICTION_MS = 30 * 24 * 60 * 60 * 1000;

interface GitHubSourceConfig {
	repo: string; // "owner/repo"
	events: string[];
	authors?: string[];
	token: string;
	/** How far back to look on initial sync (e.g. "7d", "24h"). Default: 7d */
	initial_lookback?: string;
	/** Max percentage of remaining rate limit to use per poll (0-1). Default: 0.8 */
	rate_budget?: number;
}

type GitHubPull = Record<string, unknown>;

/** Rate limit state tracked from API response headers */
interface RateLimitState {
	remaining: number;
	resetAt: Date;
}

/** Per-poll budget tracking */
interface PollBudget {
	apiCalls: number;
	startRemaining: number | null;
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
	private rateBudgetFraction = 0.8;

	// WQ-94: PR state cache — tracks updated_at per PR to skip unchanged PRs
	private prCache = new Map<number, string>();
	private lastCacheEviction = Date.now();

	// WQ-94: Per-poll budget tracking
	private pollBudget: PollBudget = { apiCalls: 0, startRemaining: null };

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

		if (cfg.rate_budget !== undefined) {
			this.rateBudgetFraction = Math.max(0, Math.min(1, cfg.rate_budget));
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

		// Reset per-poll budget tracking
		this.pollBudget = {
			apiCalls: 0,
			startRemaining: this.rateLimit?.remaining ?? null,
		};

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

			// WQ-94: Use repo-level endpoint for review comments instead of per-PR
			if (this.events.includes('pull_request_review_comment')) {
				const comments = await this.pollReviewCommentsRepoLevel(since, pulls);
				events.push(...comments);
			}

			if (this.events.includes('issue_comment')) {
				const comments = await this.pollIssueComments(since);
				events.push(...comments);
			}

			// Non-essential event types: skip if rate budget is low
			if (
				this.events.includes('pull_request.closed') ||
				this.events.includes('pull_request.merged')
			) {
				if (this.hasBudget()) {
					const prs = await this.pollClosedPRs(since);
					events.push(...prs);
				}
			}

			if (this.events.includes('pull_request.opened')) {
				if (this.hasBudget()) {
					const prs = await this.pollOpenedPRs(since);
					events.push(...prs);
				}
			}

			if (this.events.includes('pull_request.ready_for_review')) {
				if (this.hasBudget()) {
					const prs = await this.pollReadyForReviewPRs(since);
					events.push(...prs);
				}
			}

			if (this.events.includes('workflow_run.completed')) {
				if (this.hasBudget()) {
					const runs = await this.pollFailedWorkflowRuns(since);
					events.push(...runs);
				}
			}

			if (this.events.includes('check_suite.completed')) {
				if (this.hasBudget()) {
					const suites = await this.pollCheckSuites(since);
					events.push(...suites);
				}
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
				this.logBudget();
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

		// Evict stale cache entries periodically
		this.evictStaleCache();

		// Log budget usage
		this.logBudget();

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
	 * WQ-94: Check if we have enough rate budget to continue fetching.
	 * Returns false if remaining requests are below the safety threshold.
	 */
	private hasBudget(): boolean {
		if (!this.rateLimit) return true;
		// Use rateBudgetFraction to scale the threshold: lower fraction → higher threshold
		const threshold = Math.floor(RATE_BUDGET_MIN_THRESHOLD / this.rateBudgetFraction);
		return this.rateLimit.remaining > threshold;
	}

	/**
	 * WQ-94: Log budget usage at end of poll.
	 */
	private logBudget(): void {
		const used = this.pollBudget.apiCalls;
		const remaining = this.rateLimit?.remaining ?? 'unknown';
		if (used > 0) {
			console.log(`[github] Poll used ${used} API calls. Remaining: ${remaining}`);
		}
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
	 * WQ-94: Evict PR cache entries older than 30 days.
	 */
	private evictStaleCache(): void {
		const now = Date.now();
		if (now - this.lastCacheEviction < PR_CACHE_EVICTION_MS) return;

		const cutoff = new Date(now - PR_CACHE_EVICTION_MS).toISOString();
		for (const [prNumber, updatedAt] of this.prCache) {
			if (updatedAt < cutoff) {
				this.prCache.delete(prNumber);
			}
		}
		this.lastCacheEviction = now;
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
			this.pollBudget.apiCalls++;
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

	/**
	 * WQ-94: Only fetch reviews for PRs whose updated_at changed since last poll.
	 * Skips unchanged PRs to reduce API calls.
	 */
	private async pollReviews(since: string, pulls: GitHubPull[]): Promise<OrgLoopEvent[]> {
		const events: OrgLoopEvent[] = [];
		const repoData = { full_name: `${this.owner}/${this.repo}` };

		for (const pr of pulls) {
			const prNumber = pr.number as number;
			const prUpdatedAt = pr.updated_at as string;

			// WQ-94: Skip PRs whose updated_at hasn't changed since last poll
			const cachedUpdatedAt = this.prCache.get(prNumber);
			if (cachedUpdatedAt && cachedUpdatedAt === prUpdatedAt) {
				continue;
			}

			// Check rate limit before each per-PR API call
			await this.checkRateLimit();
			if (!this.hasBudget()) break;

			try {
				this.pollBudget.apiCalls++;
				const reviews = await this.octokit.paginate(this.octokit.pulls.listReviews, {
					owner: this.owner,
					repo: this.repo,
					pull_number: prNumber,
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

			// Update cache after successful fetch
			this.prCache.set(prNumber, prUpdatedAt);
		}
		return events;
	}

	/**
	 * WQ-94: Fetch review comments at repo level instead of per-PR.
	 * Uses /repos/{owner}/{repo}/pulls/comments?since= for a single API call.
	 * Maps each comment back to its PR from the pulls list.
	 */
	private async pollReviewCommentsRepoLevel(
		since: string,
		pulls: GitHubPull[],
	): Promise<OrgLoopEvent[]> {
		const events: OrgLoopEvent[] = [];
		const repoData = { full_name: `${this.owner}/${this.repo}` };

		// Build a lookup of PR number → PR data for enrichment
		const prByNumber = new Map<number, GitHubPull>();
		for (const pr of pulls) {
			prByNumber.set(pr.number as number, pr);
		}

		this.pollBudget.apiCalls++;
		const comments = await this.octokit.paginate(this.octokit.pulls.listReviewCommentsForRepo, {
			owner: this.owner,
			repo: this.repo,
			since,
			sort: 'updated',
			direction: 'desc',
			per_page: 100,
		});

		for (const comment of comments) {
			const c = comment as unknown as Record<string, unknown>;
			const updatedAt = c.updated_at as string;
			if (updatedAt <= since) continue;

			// Extract PR number from pull_request_url
			const prUrl = c.pull_request_url as string | undefined;
			const prNumber = prUrl ? Number(prUrl.split('/').pop()) : null;

			// Look up PR data from our pulls list; if missing, fetch the individual PR
			// so the normalizer can extract the pr_author (user.login) field
			let prData = prNumber ? prByNumber.get(prNumber) : undefined;
			if (!prData && prNumber) {
				prData = await this.fetchSinglePull(prNumber);
				if (prData) {
					prByNumber.set(prNumber, prData);
				}
			}

			events.push(
				normalizePullRequestReviewComment(
					this.sourceId,
					c,
					prData ?? { number: prNumber ?? 0, title: '' },
					repoData,
				),
			);
		}

		return events;
	}

	/**
	 * Fetch a single PR by number. Used when a review comment references a PR
	 * not in the recent pulls cache, so we can enrich with pr_author.
	 */
	private async fetchSinglePull(prNumber: number): Promise<GitHubPull | undefined> {
		try {
			this.pollBudget.apiCalls++;
			const { data } = await this.octokit.pulls.get({
				owner: this.owner,
				repo: this.repo,
				pull_number: prNumber,
			});
			return data as unknown as GitHubPull;
		} catch {
			console.warn(`[github] Failed to fetch PR #${prNumber} for author enrichment`);
			return undefined;
		}
	}

	private async pollIssueComments(since: string): Promise<OrgLoopEvent[]> {
		this.pollBudget.apiCalls++;
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
			this.pollBudget.apiCalls++;
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
			this.pollBudget.apiCalls++;
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
			this.pollBudget.apiCalls++;
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
			this.pollBudget.apiCalls++;
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
		this.pollBudget.apiCalls++;
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
		this.prCache.clear();
	}
}
