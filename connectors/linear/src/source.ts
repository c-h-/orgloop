/**
 * Linear source connector — polls Linear API for issue and comment activity.
 *
 * Persists issue state cache to disk for crash recovery.
 * Uses batched GraphQL queries to avoid N+1 request patterns.
 * Supports cursor-based pagination for large result sets.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinearClient } from '@linear/sdk';
import type { OrgLoopEvent, PollResult, SourceConfig, SourceConnector } from '@orgloop/sdk';
import {
	normalizeAssigneeChange,
	normalizeComment,
	normalizeIssueStateChange,
	normalizeLabelChange,
	normalizeNewIssue,
	normalizePriorityChange,
} from './normalizer.js';

/** Resolve env var references like ${LINEAR_API_KEY} */
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

interface LinearSourceConfig {
	team: string;
	project?: string;
	api_key: string;
	cache_dir?: string;
}

/** Per-issue cached state for detecting changes across polls */
export interface CachedIssueState {
	state: string;
	assignee: string | null;
	priority: number;
	labels: string[];
}

export class LinearSource implements SourceConnector {
	readonly id = 'linear';
	private client!: LinearClient;
	private teamKey = '';
	private projectName?: string;
	private sourceId = '';
	private cacheDir = '';
	private stateCache = new Map<string, CachedIssueState>();

	async init(config: SourceConfig): Promise<void> {
		const cfg = config.config as unknown as LinearSourceConfig;
		this.teamKey = cfg.team;
		this.projectName = cfg.project;
		this.sourceId = config.id;

		const apiKey = resolveEnvVar(cfg.api_key);
		this.client = new LinearClient({ apiKey });

		// Set up cache directory
		this.cacheDir = cfg.cache_dir ?? join(tmpdir(), 'orgloop-linear');
		if (!existsSync(this.cacheDir)) {
			mkdirSync(this.cacheDir, { recursive: true });
		}

		// Load persisted state cache
		this.loadStateCache();
	}

	async poll(checkpoint: string | null): Promise<PollResult> {
		const since = checkpoint ?? new Date(Date.now() - 5 * 60 * 1000).toISOString();
		const events: OrgLoopEvent[] = [];
		let latestTimestamp = since;

		try {
			const issueEvents = await this.pollIssues(since);
			events.push(...issueEvents);

			const commentEvents = await this.pollComments(since);
			events.push(...commentEvents);
		} catch (err: unknown) {
			const error = err as { status?: number; extensions?: { code?: string }; message?: string };
			if (error.status === 429 || error.extensions?.code === 'RATE_LIMITED') {
				return { events: [], checkpoint: since };
			}
			if (error.status === 401 || error.status === 403) {
				console.error(`[linear] Auth error: ${error.message}`);
				return { events: [], checkpoint: since };
			}
			throw err;
		}

		for (const event of events) {
			if (event.timestamp > latestTimestamp) {
				latestTimestamp = event.timestamp;
			}
		}

		// Persist state cache after every poll
		this.saveStateCache();

		return { events, checkpoint: latestTimestamp };
	}

	private async pollIssues(since: string): Promise<OrgLoopEvent[]> {
		const events: OrgLoopEvent[] = [];

		const team = await this.client.team(this.teamKey);

		// Paginate through all updated issues
		let hasMore = true;
		let cursor: string | undefined;

		while (hasMore) {
			const issues = await team.issues({
				filter: {
					updatedAt: { gte: new Date(since) },
					...(this.projectName ? { project: { name: { eq: this.projectName } } } : {}),
				},
				first: 50,
				after: cursor,
			});

			for (const issue of issues.nodes) {
				// Fetch relations in parallel to avoid N+1
				const [state, assignee, creator, labels] = await Promise.all([
					issue.state,
					issue.assignee,
					issue.creator,
					issue.labels(),
				]);
				const stateName = state?.name ?? 'Unknown';
				const assigneeName = assignee?.name ?? null;
				const priority = issue.priority;
				const labelNames = labels.nodes.map((l) => l.name).sort();

				const cached = this.stateCache.get(issue.id);

				if (cached === undefined) {
					// First time seeing this issue — check if recently created
					if (issue.createdAt.toISOString() > since) {
						events.push(
							normalizeNewIssue(this.sourceId, {
								id: issue.id,
								identifier: issue.identifier,
								title: issue.title,
								description: issue.description,
								url: issue.url,
								state: { name: stateName },
								creator: creator ? { name: creator.name } : null,
								createdAt: issue.createdAt.toISOString(),
							}),
						);
					}
				} else {
					const issueData = {
						identifier: issue.identifier,
						title: issue.title,
						url: issue.url,
						assignee: assignee ? { name: assignee.name } : null,
						updatedAt: issue.updatedAt.toISOString(),
					};

					// Detect state change
					if (cached.state !== stateName) {
						events.push(
							normalizeIssueStateChange(
								this.sourceId,
								{ id: issue.id, state: { name: stateName }, ...issueData },
								cached.state,
							),
						);
					}

					// Detect assignee change
					if (cached.assignee !== assigneeName) {
						events.push(normalizeAssigneeChange(this.sourceId, issueData, cached.assignee));
					}

					// Detect priority change
					if (cached.priority !== priority) {
						events.push(
							normalizePriorityChange(this.sourceId, issueData, cached.priority, priority),
						);
					}

					// Detect label changes
					if (JSON.stringify(cached.labels) !== JSON.stringify(labelNames)) {
						events.push(normalizeLabelChange(this.sourceId, issueData, cached.labels, labelNames));
					}
				}

				// Update cache
				this.stateCache.set(issue.id, {
					state: stateName,
					assignee: assigneeName,
					priority,
					labels: labelNames,
				});
			}

			hasMore = issues.pageInfo.hasNextPage;
			cursor = issues.pageInfo.endCursor ?? undefined;
		}

		return events;
	}

	private async pollComments(since: string): Promise<OrgLoopEvent[]> {
		const events: OrgLoopEvent[] = [];

		// Filter comments by team to reduce waste
		const team = await this.client.team(this.teamKey);
		const issues = await team.issues({
			filter: {
				updatedAt: { gte: new Date(since) },
				...(this.projectName ? { project: { name: { eq: this.projectName } } } : {}),
			},
			first: 50,
		});

		for (const issue of issues.nodes) {
			const comments = await issue.comments({
				filter: { createdAt: { gte: new Date(since) } },
				first: 50,
			});

			for (const comment of comments.nodes) {
				const user = await comment.user;
				events.push(
					normalizeComment(
						this.sourceId,
						{
							id: comment.id,
							body: comment.body,
							url: comment.url,
							createdAt: comment.createdAt.toISOString(),
							user: user ? { name: user.name } : null,
						},
						{
							identifier: issue.identifier,
							title: issue.title,
						},
					),
				);
			}
		}

		return events;
	}

	private get cachePath(): string {
		return join(this.cacheDir, `${this.sourceId}-state-cache.json`);
	}

	private loadStateCache(): void {
		try {
			if (existsSync(this.cachePath)) {
				const raw = readFileSync(this.cachePath, 'utf-8');
				const data = JSON.parse(raw) as Record<string, CachedIssueState>;
				this.stateCache = new Map(Object.entries(data));
			}
		} catch {
			// Corrupt cache — start fresh
			this.stateCache = new Map();
		}
	}

	private saveStateCache(): void {
		try {
			const data = Object.fromEntries(this.stateCache);
			writeFileSync(this.cachePath, JSON.stringify(data, null, 2));
		} catch {
			// Non-fatal — cache will be rebuilt on next poll
			console.error('[linear] Failed to persist state cache');
		}
	}

	async shutdown(): Promise<void> {
		this.saveStateCache();
		this.stateCache.clear();
	}
}
