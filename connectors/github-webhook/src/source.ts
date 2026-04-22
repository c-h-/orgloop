/**
 * GitHub webhook source connector — receives GitHub webhook POST deliveries
 * and normalizes them into OrgLoop events using the same normalizers as the
 * polling connector.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
} from '@orgloop/connector-github';
import type {
	OrgLoopEvent,
	PollResult,
	SourceConfig,
	SourceConnector,
	WebhookHandler,
} from '@orgloop/sdk';
import { buildEvent, EventBuffer, parseBufferSize } from '@orgloop/sdk';

export interface GitHubWebhookConfig {
	/** HMAC-SHA256 secret for validating webhook signatures */
	secret?: string;
	/** URL path to mount the webhook handler on */
	path?: string;
	/** Event types to accept (e.g., ["pull_request", "issue_comment"]) */
	events?: string[];
	/** Directory for persisting buffered events across restarts */
	buffer_dir?: string;
	/** Maximum buffer file size (e.g. "50MB", "1GB"). Default: 50MB. */
	max_buffer_size?: string;
	/** GitHub API token for enriching events (e.g. workflow_run PR lookup) */
	token?: string;
	/** GitHub repo owner (e.g. "UsableMachines") for PR lookups */
	repo_owner?: string;
	/** GitHub repo name (e.g. "mono") for PR lookups */
	repo_name?: string;
}

/** Resolve env var references like ${WEBHOOK_SECRET} */
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

export class GitHubWebhookSource implements SourceConnector {
	readonly id = 'github-webhook';
	private secret?: string;
	private sourceId = 'github-webhook';
	private allowedEvents?: Set<string>;
	private pendingEvents: OrgLoopEvent[] = [];
	private buffer?: EventBuffer;
	private githubToken?: string;
	private repoOwner?: string;
	private repoName?: string;

	async init(config: SourceConfig): Promise<void> {
		this.sourceId = config.id;
		const cfg = config.config as unknown as GitHubWebhookConfig;

		if (cfg.secret) {
			this.secret = resolveEnvVar(cfg.secret);
		}

		if (cfg.events && cfg.events.length > 0) {
			this.allowedEvents = new Set(cfg.events);
		}

		if (cfg.token) {
			this.githubToken = resolveEnvVar(cfg.token);
		}
		if (cfg.repo_owner) {
			this.repoOwner = resolveEnvVar(cfg.repo_owner);
		}
		if (cfg.repo_name) {
			this.repoName = resolveEnvVar(cfg.repo_name);
		}

		if (cfg.buffer_dir) {
			const dir = resolveEnvVar(cfg.buffer_dir);
			this.buffer = new EventBuffer({
				bufferDir: dir,
				filePrefix: 'github-webhook',
				sourceId: this.sourceId,
				maxBufferBytes: cfg.max_buffer_size ? parseBufferSize(cfg.max_buffer_size) : undefined,
			});
			this.buffer.ensureDir();
		}
	}

	async poll(_checkpoint: string | null): Promise<PollResult> {
		let events: OrgLoopEvent[];
		if (this.buffer) {
			events = this.buffer.drainSync();
		} else {
			events = [...this.pendingEvents];
			this.pendingEvents = [];
		}
		const checkpoint =
			events.length > 0 ? events[events.length - 1].timestamp : new Date().toISOString();
		return { events, checkpoint };
	}

	webhook(): WebhookHandler {
		return async (req: IncomingMessage, res: ServerResponse): Promise<OrgLoopEvent[]> => {
			if (req.method !== 'POST') {
				res.writeHead(405, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Method not allowed' }));
				return [];
			}

			const bodyStr = await readBody(req);

			// HMAC-SHA256 signature validation
			if (this.secret) {
				const signature = req.headers['x-hub-signature-256'] as string | undefined;
				if (!signature) {
					res.writeHead(401, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Missing X-Hub-Signature-256 header' }));
					return [];
				}

				const expected = `sha256=${createHmac('sha256', this.secret).update(bodyStr).digest('hex')}`;
				const sigBuffer = Buffer.from(signature);
				const expectedBuffer = Buffer.from(expected);
				if (
					sigBuffer.length !== expectedBuffer.length ||
					!timingSafeEqual(sigBuffer, expectedBuffer)
				) {
					res.writeHead(401, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Invalid signature' }));
					return [];
				}
			}

			// Parse the webhook event type from GitHub headers
			const githubEvent = req.headers['x-github-event'] as string | undefined;
			if (!githubEvent) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Missing X-GitHub-Event header' }));
				return [];
			}

			let payload: Record<string, unknown>;
			try {
				payload = JSON.parse(bodyStr) as Record<string, unknown>;
			} catch {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
				return [];
			}

			const events = await this.normalizeWebhookPayload(githubEvent, payload);

			for (const event of events) {
				this.persistEvent(event);
			}

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(
				JSON.stringify({
					ok: true,
					events_created: events.length,
					event_ids: events.map((e) => e.id),
				}),
			);
			return events;
		};
	}

	async shutdown(): Promise<void> {
		this.pendingEvents = [];
	}

	/**
	 * Normalize a GitHub webhook payload into OrgLoop events.
	 * Uses the same normalizer functions as the polling connector.
	 */
	async normalizeWebhookPayload(
		githubEvent: string,
		payload: Record<string, unknown>,
	): Promise<OrgLoopEvent[]> {
		const action = payload.action as string | undefined;
		const repo = (payload.repository as Record<string, unknown>) ?? {};

		switch (githubEvent) {
			case 'pull_request_review': {
				if (!this.isEventAllowed('pull_request.review_submitted')) return [];
				const review = payload.review as Record<string, unknown>;
				const pr = payload.pull_request as Record<string, unknown>;
				if (!review || !pr) return [];
				return [normalizePullRequestReview(this.sourceId, review, pr, repo)];
			}

			case 'pull_request_review_comment': {
				if (!this.isEventAllowed('pull_request_review_comment')) return [];
				const comment = payload.comment as Record<string, unknown>;
				const pr = payload.pull_request as Record<string, unknown>;
				if (!comment || !pr) return [];
				return [normalizePullRequestReviewComment(this.sourceId, comment, pr, repo)];
			}

			case 'issue_comment': {
				if (!this.isEventAllowed('issue_comment')) return [];
				const comment = payload.comment as Record<string, unknown>;
				const issue = payload.issue as Record<string, unknown>;
				if (!comment || !issue) return [];
				return [normalizeIssueComment(this.sourceId, comment, issue, repo)];
			}

			case 'pull_request': {
				const pr = payload.pull_request as Record<string, unknown>;
				if (!pr) return [];

				if (action === 'closed') {
					if (
						!this.isEventAllowed('pull_request.closed') &&
						!this.isEventAllowed('pull_request.merged')
					)
						return [];
					return [normalizePullRequestClosed(this.sourceId, pr, repo)];
				}
				if (action === 'opened') {
					if (!this.isEventAllowed('pull_request.opened')) return [];
					return [normalizePullRequestOpened(this.sourceId, pr, repo)];
				}
				if (action === 'ready_for_review') {
					if (!this.isEventAllowed('pull_request.ready_for_review')) return [];
					return [normalizePullRequestReadyForReview(this.sourceId, pr, repo)];
				}
				// Unhandled pull_request action — emit raw event
				return this.buildRawEvent(githubEvent, action, payload);
			}

			case 'workflow_run': {
				if (!this.isEventAllowed('workflow_run.completed')) return [];
				if (action !== 'completed') return [];
				let run = payload.workflow_run as Record<string, unknown>;
				if (!run) return [];
				const conclusion = run.conclusion as string;
				if (conclusion === 'failure') {
					// Enrich workflow_run with PR data when pull_requests is empty
					run = await this.enrichWorkflowRun(run, repo);
					return [normalizeWorkflowRunFailed(this.sourceId, run, repo)];
				}
				// Non-failure workflow runs — emit raw event
				return this.buildRawEvent(githubEvent, action, payload);
			}

			case 'issues': {
				const issue = payload.issue as Record<string, unknown>;
				if (!issue || issue.pull_request) return [];
				// GitHub webhook sends `sender` as the actor; normalizers expect `actor`
				const issueEvent = {
					actor: payload.sender,
					issue,
					label: payload.label,
					assignee: payload.assignee,
				};
				if (action === 'opened') {
					if (!this.isEventAllowed('issues.opened')) return [];
					return [normalizeIssueOpened(this.sourceId, issueEvent, repo)];
				}
				if (action === 'labeled') {
					if (!this.isEventAllowed('issues.labeled')) return [];
					return [normalizeIssueLabeled(this.sourceId, issueEvent, repo)];
				}
				if (action === 'assigned') {
					if (!this.isEventAllowed('issues.assigned')) return [];
					return [normalizeIssueAssigned(this.sourceId, issueEvent, repo)];
				}
				return this.buildRawEvent(githubEvent, action, payload);
			}

			case 'check_suite': {
				if (!this.isEventAllowed('check_suite.completed')) return [];
				if (action !== 'completed') return [];
				const suite = payload.check_suite as Record<string, unknown>;
				if (!suite) return [];
				return [normalizeCheckSuiteCompleted(this.sourceId, suite, repo)];
			}

			default:
				// Unknown event type — emit raw event for extensibility
				return this.buildRawEvent(githubEvent, action, payload);
		}
	}

	/**
	 * Enrich a workflow_run payload with PR labels and author when the
	 * pull_requests array is empty. GitHub often omits PR data from
	 * workflow_run webhooks for cross-fork or rebased PRs.
	 *
	 * Looks up PRs by head_branch using the GitHub API. Falls back
	 * gracefully if no token is configured or the API call fails.
	 */
	private async enrichWorkflowRun(
		run: Record<string, unknown>,
		repo: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const prs = run.pull_requests as Array<Record<string, unknown>> | undefined;
		if (prs && prs.length > 0) {
			// Already has PR data — no enrichment needed
			return run;
		}

		if (!this.githubToken) {
			// No token configured — can't enrich, pass through as-is
			return run;
		}

		const headBranch = run.head_branch as string | undefined;
		if (!headBranch) {
			return run;
		}

		// Determine repo owner/name — prefer webhook payload, fall back to config
		const repoFullName = repo.full_name as string | undefined;
		let owner: string | undefined;
		let name: string | undefined;
		if (repoFullName) {
			const parts = repoFullName.split('/');
			owner = parts[0];
			name = parts[1];
		}
		owner = owner ?? this.repoOwner;
		name = name ?? this.repoName;
		if (!owner || !name) {
			return run;
		}

		try {
			// Search for open PRs matching this head branch
			const response = await fetch(
				`https://api.github.com/repos/${owner}/${name}/pulls?head=${owner}:${headBranch}&state=open&per_page=1`,
				{
					headers: {
						Authorization: `Bearer ${this.githubToken}`,
						Accept: 'application/vnd.github+json',
						'X-GitHub-Api-Version': '2022-11-28',
					},
				},
			);

			if (!response.ok) {
				// API error — don't block the event, just pass through without enrichment
				return run;
			}

			const pullRequests = (await response.json()) as Array<Record<string, unknown>>;
			if (pullRequests.length === 0) {
				// No matching PR found — pass through as-is
				return run;
			}

			// Inject the found PR into the run's pull_requests array
			// so the normalizer can extract labels and pr_author
			return { ...run, pull_requests: pullRequests };
		} catch {
			// Network error or other failure — don't drop the event
			return run;
		}
	}

	private isEventAllowed(eventType: string): boolean {
		if (!this.allowedEvents) return true;
		return this.allowedEvents.has(eventType);
	}

	private buildRawEvent(
		githubEvent: string,
		action: string | undefined,
		payload: Record<string, unknown>,
	): OrgLoopEvent[] {
		const platformEvent = action ? `${githubEvent}.${action}` : githubEvent;
		return [
			buildEvent({
				source: this.sourceId,
				type: 'resource.changed',
				provenance: {
					platform: 'github',
					platform_event: platformEvent,
				},
				payload,
			}),
		];
	}

	private persistEvent(event: OrgLoopEvent): void {
		if (this.buffer) {
			this.buffer.append(event);
			this.buffer.enforceSize();
		} else {
			this.pendingEvents.push(event);
		}
	}
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
		req.on('error', reject);
	});
}
