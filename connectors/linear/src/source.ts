/**
 * Linear source connector — polls Linear API for issue and comment activity.
 *
 * Uses batched GraphQL queries to fetch issues with all relations
 * (state, assignee, creator, labels, comments) in a single request,
 * eliminating the N+1 pattern of per-issue relation fetches.
 *
 * Persists issue state cache to disk for crash recovery.
 * Supports cursor-based pagination for large result sets.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	HttpAgent,
	OrgLoopEvent,
	PollResult,
	SourceConfig,
	SourceConnector,
} from '@orgloop/sdk';
import { closeHttpAgent, createFetchWithKeepAlive, createHttpAgent } from '@orgloop/sdk';
import type { BatchIssueNode } from './graphql.js';
import { executeBatchQuery } from './graphql.js';
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
	private apiKey = '';
	private teamKey = '';
	private projectName?: string;
	private sourceId = '';
	private cacheDir = '';
	private stateCache = new Map<string, CachedIssueState>();
	private httpAgent: HttpAgent | null = null;

	async init(config: SourceConfig): Promise<void> {
		const cfg = config.config as unknown as LinearSourceConfig;
		this.teamKey = cfg.team;
		this.projectName = cfg.project;
		this.sourceId = config.id;

		this.apiKey = resolveEnvVar(cfg.api_key);
		this.httpAgent = createHttpAgent();

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
			const batchEvents = await this.pollBatch(since);
			events.push(...batchEvents);
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

	/**
	 * Batch poll: fetches issues with all relations (state, assignee, creator,
	 * labels, comments) in a single GraphQL request per page.
	 *
	 * Replaces the old pollIssues() + pollComments() two-pass pattern that
	 * caused N+1 requests via the @linear/sdk lazy-loading.
	 */
	private async pollBatch(since: string): Promise<OrgLoopEvent[]> {
		const events: OrgLoopEvent[] = [];

		let hasMore = true;
		let cursor: string | undefined;

		while (hasMore) {
			const data = await executeBatchQuery({
				apiKey: this.apiKey,
				teamKey: this.teamKey,
				since,
				projectName: this.projectName,
				cursor,
				fetch: this.httpAgent ? createFetchWithKeepAlive(this.httpAgent) : undefined,
			});

			const { nodes, pageInfo } = data.team.issues;

			for (const issue of nodes) {
				// Process issue changes (state, assignee, priority, labels)
				this.processIssueChanges(issue, since, events);

				// Process comments from the same batch response
				for (const comment of issue.comments.nodes) {
					events.push(
						normalizeComment(
							this.sourceId,
							{
								id: comment.id,
								body: comment.body,
								url: comment.url,
								createdAt: comment.createdAt,
								user: comment.user,
							},
							{
								identifier: issue.identifier,
								title: issue.title,
								assignee: issue.assignee,
								creator: issue.creator,
							},
						),
					);
				}
			}

			hasMore = pageInfo.hasNextPage;
			cursor = pageInfo.endCursor ?? undefined;
		}

		return events;
	}

	/**
	 * Process a single issue from the batch response: detect new issues and
	 * state/assignee/priority/label changes against the cache.
	 */
	private processIssueChanges(issue: BatchIssueNode, since: string, events: OrgLoopEvent[]): void {
		const stateName = issue.state?.name ?? 'Unknown';
		const assigneeName = issue.assignee?.name ?? null;
		const priority = issue.priority;
		const labelNames = issue.labels.nodes.map((l) => l.name).sort();

		const cached = this.stateCache.get(issue.id);

		if (cached === undefined) {
			// First time seeing this issue — check if recently created
			if (issue.createdAt > since) {
				events.push(
					normalizeNewIssue(this.sourceId, {
						id: issue.id,
						identifier: issue.identifier,
						title: issue.title,
						description: issue.description,
						url: issue.url,
						state: { name: stateName },
						creator: issue.creator,
						createdAt: issue.createdAt,
					}),
				);
			}
		} else {
			const issueData = {
				identifier: issue.identifier,
				title: issue.title,
				url: issue.url,
				assignee: issue.assignee,
				updatedAt: issue.updatedAt,
			};

			if (cached.state !== stateName) {
				events.push(
					normalizeIssueStateChange(
						this.sourceId,
						{ id: issue.id, state: { name: stateName }, ...issueData },
						cached.state,
					),
				);
			}

			if (cached.assignee !== assigneeName) {
				events.push(normalizeAssigneeChange(this.sourceId, issueData, cached.assignee));
			}

			if (cached.priority !== priority) {
				events.push(normalizePriorityChange(this.sourceId, issueData, cached.priority, priority));
			}

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
		if (this.httpAgent) {
			await closeHttpAgent(this.httpAgent);
			this.httpAgent = null;
		}
	}
}
