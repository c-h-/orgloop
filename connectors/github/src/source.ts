/**
 * GitHub source connector — polls GitHub API for repository events.
 *
 * Uses a batched GraphQL query for PR-related events (reviews, closed,
 * opened, ready-for-review) to eliminate the N+1 pattern of per-PR REST
 * calls. Remaining endpoints (review comments, issue comments, workflow
 * runs, check suites) use efficient single-call REST endpoints.
 *
 * Rate limit awareness: reads X-RateLimit-Remaining/Reset headers for REST,
 * rateLimit query field for GraphQL. Warns when low, pauses when exhausted.
 * Initial sync defaults to a configurable lookback window (default 7d).
 */

import { Octokit } from '@octokit/rest';
import type {
	HttpAgent,
	OrgLoopEvent,
	PollResult,
	SourceConfig,
	SourceConnector,
} from '@orgloop/sdk';
import {
	closeHttpAgent,
	createFetchWithKeepAlive,
	createHttpAgent,
	parseDuration,
} from '@orgloop/sdk';
import { executeBatchPRQuery } from './graphql.js';
import {
	normalizeCheckSuiteCompleted,
	normalizeIssueAssigned,
	normalizeIssueComment,
	normalizeIssueLabeled,
	normalizeIssueOpened,
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

	// HTTP keep-alive agent for connection reuse across polls
	private httpAgent: HttpAgent | null = null;

	// WQ-94: PR state cache — tracks updated_at per PR to skip unchanged PRs
	private prCache = new Map<number, string>();
	private lastCacheEviction = Date.now();

	// WQ-94: Per-poll budget tracking
	private pollBudget: PollBudget = { apiCalls: 0, startRemaining: null };

	// Token rotation: store the raw config string (e.g. "${GITHUB_TOKEN}")
	// so we can re-resolve the env var on each poll and detect changes.
	private rawTokenConfig = '';
	private resolvedToken = '';

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

		this.rawTokenConfig = cfg.token;
		this.resolvedToken = resolveEnvVar(cfg.token);
		this.httpAgent = createHttpAgent();
		this.octokit = new Octokit({
			auth: this.resolvedToken,
			request: { fetch: createFetchWithKeepAlive(this.httpAgent) },
		});
	}

	/**
	 * Re-resolve the token from env vars. If the token changed
	 * (e.g. rotated by an external refresh script), recreate the Octokit client.
	 * Returns true if the token was refreshed.
	 */
	private refreshTokenIfChanged(): boolean {
		try {
			const currentToken = resolveEnvVar(this.rawTokenConfig);
			if (currentToken !== this.resolvedToken) {
				console.log('[github] Token changed, refreshing Octokit client');
				this.resolvedToken = currentToken;
				this.octokit = new Octokit({
					auth: currentToken,
					request: this.httpAgent ? { fetch: createFetchWithKeepAlive(this.httpAgent) } : undefined,
				});
				return true;
			}
		} catch {
			// If env var resolution fails, keep using the current token
		}
		return false;
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

		// Proactively check if the token has been rotated (e.g. by a refresh script)
		this.refreshTokenIfChanged();

		// Reset per-poll budget tracking
		this.pollBudget = {
			apiCalls: 0,
			startRemaining: this.rateLimit?.remaining ?? null,
		};

		try {
			// Check rate limit before starting
			await this.checkRateLimit();

			// ─── Batch GraphQL: PRs + Reviews ───────────────────────────
			// Single GraphQL query replaces: fetchUpdatedPulls + pollReviews
			// + pollClosedPRs + pollOpenedPRs + pollReadyForReviewPRs

			const needsPRBatch =
				this.events.includes('pull_request.review_submitted') ||
				this.events.includes('pull_request_review_comment') ||
				this.events.includes('pull_request.closed') ||
				this.events.includes('pull_request.merged') ||
				this.events.includes('pull_request.opened') ||
				this.events.includes('pull_request.ready_for_review');

			let pulls: GitHubPull[] = [];

			if (needsPRBatch) {
				const batchResult = await executeBatchPRQuery({
					octokit: this.octokit,
					owner: this.owner,
					repo: this.repo,
					since,
				});
				this.pollBudget.apiCalls++;

				// Update rate limit from GraphQL response
				this.rateLimit = batchResult.rateLimit;

				pulls = batchResult.pulls;
				const repoData = { full_name: `${this.owner}/${this.repo}` };

				// PR reviews
				if (this.events.includes('pull_request.review_submitted')) {
					// Filter by PR cache: skip reviews on PRs whose updated_at didn't change
					for (const { review, pr } of batchResult.reviews) {
						const prNumber = pr.number as number;
						const prUpdatedAt = pr.updated_at as string;
						const cachedUpdatedAt = this.prCache.get(prNumber);
						if (cachedUpdatedAt && cachedUpdatedAt === prUpdatedAt) {
							continue;
						}
						events.push(normalizePullRequestReview(this.sourceId, review, pr, repoData));
					}
					// Update PR cache
					for (const pr of pulls) {
						this.prCache.set(pr.number as number, pr.updated_at as string);
					}
				}

				// Closed/merged PRs
				if (
					this.events.includes('pull_request.closed') ||
					this.events.includes('pull_request.merged')
				) {
					for (const pr of batchResult.closedPRs) {
						events.push(normalizePullRequestClosed(this.sourceId, pr, repoData));
					}
				}

				// Opened PRs
				if (this.events.includes('pull_request.opened')) {
					for (const pr of batchResult.openedPRs) {
						events.push(normalizePullRequestOpened(this.sourceId, pr, repoData));
					}
				}

				// Ready for review PRs
				if (this.events.includes('pull_request.ready_for_review')) {
					for (const pr of batchResult.readyForReviewPRs) {
						events.push(normalizePullRequestReadyForReview(this.sourceId, pr, repoData));
					}
				}
			}

			// ─── REST: Review comments (repo-level, single call) ────────
			if (this.events.includes('pull_request_review_comment')) {
				const comments = await this.pollReviewCommentsRepoLevel(since, pulls);
				events.push(...comments);
			}

			// ─── REST: Issue comments (single call) ─────────────────────
			if (this.events.includes('issue_comment')) {
				const comments = await this.pollIssueComments(since);
				events.push(...comments);
			}

			// ─── REST: Issue events (opened, labeled, assigned) ──────────
			const needsIssueEvents =
				this.events.includes('issues.opened') ||
				this.events.includes('issues.labeled') ||
				this.events.includes('issues.assigned');

			if (needsIssueEvents) {
				const issueEvents = await this.pollIssueEvents(since);
				events.push(...issueEvents);
			}

			// ─── REST: Non-essential events (skip if budget low) ────────
			if (this.events.includes('workflow_run.completed')) {
				if (this.hasBudget()) {
					try {
						const runs = await this.pollFailedWorkflowRuns(since);
						events.push(...runs);
					} catch (e: unknown) {
						console.warn(`[github] Failed to poll workflow runs: ${(e as Error).message}`);
					}
				}
			}

			if (this.events.includes('check_suite.completed')) {
				if (this.hasBudget()) {
					try {
						const suites = await this.pollCheckSuites(since);
						events.push(...suites);
					} catch (e: unknown) {
						console.warn(`[github] Failed to poll check suites: ${(e as Error).message}`);
					}
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
				this.logBudget();
				return {
					events: this.filterByAuthors(events),
					checkpoint: this.advanceCheckpoint(events, latestTimestamp),
				};
			}
			if (error.status === 401 || (error.status === 403 && !this.isRateLimited())) {
				// Token may have expired — try refreshing from env vars
				if (this.refreshTokenIfChanged()) {
					console.log('[github] Token refreshed after auth error, will retry on next poll');
				} else {
					console.error(`[github] Auth error (token unchanged): ${error.message}`);
				}
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

			if (!prData && prNumber) {
				console.warn(
					`[github] Review comment on PR #${prNumber} will have pr_author='unknown' (PR data unavailable)`,
				);
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
	 *
	 * Retries once after a short delay on transient errors (rate limits,
	 * network blips) to avoid silently degrading pr_author to 'unknown'.
	 */
	private async fetchSinglePull(prNumber: number): Promise<GitHubPull | undefined> {
		const maxAttempts = 2;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				await this.checkRateLimit();
				this.pollBudget.apiCalls++;
				const { data, headers } = await this.octokit.pulls.get({
					owner: this.owner,
					repo: this.repo,
					pull_number: prNumber,
				});
				if (headers) {
					this.updateRateLimitFromHeaders(headers as unknown as Record<string, string>);
				}
				return data as unknown as GitHubPull;
			} catch (err: unknown) {
				const error = err as {
					status?: number;
					message?: string;
					response?: { headers?: Record<string, string> };
				};
				if (error.response?.headers) {
					this.updateRateLimitFromHeaders(error.response.headers);
				}
				const isRetryable = error.status === 429 || error.status === 502 || error.status === 503;
				if (isRetryable && attempt < maxAttempts) {
					const delayMs = error.status === 429 ? 2000 : 1000;
					console.warn(
						`[github] fetchSinglePull PR #${prNumber} attempt ${attempt} failed (${error.status}), retrying in ${delayMs}ms`,
					);
					await new Promise((resolve) => setTimeout(resolve, delayMs));
					continue;
				}
				console.warn(
					`[github] Failed to fetch PR #${prNumber} for author enrichment after ${attempt} attempt(s): ${error.status ?? ''} ${error.message ?? 'unknown error'}`,
				);
				return undefined;
			}
		}
		return undefined;
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

	/**
	 * Poll issue events (opened, labeled, assigned) via the repo-level
	 * issues events endpoint. Uses paginated iterator with early termination
	 * when all events on a page are older than since.
	 * Skips events on pull requests (PRs are issues in GitHub's data model).
	 */
	private async pollIssueEvents(since: string): Promise<OrgLoopEvent[]> {
		const events: OrgLoopEvent[] = [];
		const repoData = { full_name: `${this.owner}/${this.repo}` };

		const eventFilter = new Set<string>();
		if (this.events.includes('issues.opened')) eventFilter.add('opened');
		if (this.events.includes('issues.labeled')) eventFilter.add('labeled');
		if (this.events.includes('issues.assigned')) eventFilter.add('assigned');

		const iterator = this.octokit.paginate.iterator(this.octokit.issues.listEventsForRepo, {
			owner: this.owner,
			repo: this.repo,
			per_page: 100,
		});

		for await (const response of iterator) {
			this.pollBudget.apiCalls++;
			if (response.headers) {
				this.updateRateLimitFromHeaders(response.headers as unknown as Record<string, string>);
			}

			const issueEvents = response.data as unknown as Record<string, unknown>[];
			let allOlderThanSince = true;

			for (const issueEvent of issueEvents) {
				const createdAt = issueEvent.created_at as string;
				if (createdAt && createdAt >= since) {
					allOlderThanSince = false;
					if (createdAt > since) {
						const eventType = issueEvent.event as string;
						if (!eventFilter.has(eventType)) continue;

						// Skip events on pull requests
						const issue = issueEvent.issue as Record<string, unknown> | undefined;
						if (issue?.pull_request) continue;

						if (eventType === 'opened') {
							events.push(normalizeIssueOpened(this.sourceId, issueEvent, repoData));
						} else if (eventType === 'labeled') {
							events.push(normalizeIssueLabeled(this.sourceId, issueEvent, repoData));
						} else if (eventType === 'assigned') {
							events.push(normalizeIssueAssigned(this.sourceId, issueEvent, repoData));
						}
					}
				}
			}

			if (allOlderThanSince && issueEvents.length > 0) {
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
		if (this.httpAgent) {
			await closeHttpAgent(this.httpAgent);
			this.httpAgent = null;
		}
	}
}
