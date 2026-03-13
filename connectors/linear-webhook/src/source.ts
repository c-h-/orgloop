/**
 * Linear webhook source connector — receives Linear webhook POST deliveries
 * and normalizes them into OrgLoop events using the same normalizers as the
 * polling connector.
 *
 * Linear webhook payload shape:
 *   { action, createdAt, data, type, url, updatedFrom }
 *
 * Signature: Linear-Signature header, HMAC-SHA256 of raw body with signing secret.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
	normalizeAssigneeChange,
	normalizeComment,
	normalizeIssueStateChange,
	normalizeLabelChange,
	normalizeNewIssue,
	normalizePriorityChange,
} from '@orgloop/connector-linear';
import type {
	OrgLoopEvent,
	PollResult,
	SourceConfig,
	SourceConnector,
	WebhookHandler,
} from '@orgloop/sdk';
import { buildEvent } from '@orgloop/sdk';

export interface LinearWebhookConfig {
	/** HMAC signing secret for validating webhook signatures */
	secret?: string;
	/** URL path to mount the webhook handler on */
	path?: string;
	/** Event types to accept (e.g., ["Issue", "Comment"]) */
	events?: string[];
	/** Optional team key filter — only process events for this team */
	team?: string;
	/** Directory for persisting buffered events across restarts */
	buffer_dir?: string;
}

/** Resolve env var references like ${LINEAR_WEBHOOK_SECRET} */
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

/**
 * Extract a human-readable state name from a webhook state value.
 * Linear webhooks may send state as:
 *   - an object like { id, name, type } → use .name
 *   - a plain string (state name) → use directly
 *   - undefined (e.g. updatedFrom only has stateId) → use fallback
 */
function resolveStateName(state: unknown, fallback = 'Unknown'): string {
	if (state == null) return fallback;
	if (typeof state === 'string') return state;
	if (typeof state === 'object') {
		const name = (state as Record<string, unknown>).name;
		if (typeof name === 'string') return name;
	}
	return fallback;
}

export class LinearWebhookSource implements SourceConnector {
	readonly id = 'linear-webhook';
	private secret?: string;
	private sourceId = 'linear-webhook';
	private allowedEvents?: Set<string>;
	private teamFilter?: string;
	private pendingEvents: OrgLoopEvent[] = [];
	private bufferPath?: string;

	async init(config: SourceConfig): Promise<void> {
		this.sourceId = config.id;
		const cfg = config.config as unknown as LinearWebhookConfig;

		if (cfg.secret) {
			this.secret = resolveEnvVar(cfg.secret);
		}

		if (cfg.events && cfg.events.length > 0) {
			this.allowedEvents = new Set(cfg.events);
		}

		if (cfg.team) {
			this.teamFilter = cfg.team;
		}

		if (cfg.buffer_dir) {
			const dir = resolveEnvVar(cfg.buffer_dir);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			this.bufferPath = join(dir, `linear-webhook-${this.sourceId}.jsonl`);
			this.loadBufferedEvents();
		}
	}

	async poll(_checkpoint: string | null): Promise<PollResult> {
		let events: OrgLoopEvent[];
		if (this.bufferPath) {
			events = this.loadBufferedEvents();
			writeFileSync(this.bufferPath, '');
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
				const signature = req.headers['linear-signature'] as string | undefined;
				if (!signature) {
					res.writeHead(401, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Missing Linear-Signature header' }));
					return [];
				}

				const expected = createHmac('sha256', this.secret).update(bodyStr).digest('hex');
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

			let payload: Record<string, unknown>;
			try {
				payload = JSON.parse(bodyStr) as Record<string, unknown>;
			} catch {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
				return [];
			}

			// Linear webhook payloads have: action, type, data, url, createdAt, updatedFrom
			const resourceType = payload.type as string | undefined;
			const action = payload.action as string | undefined;
			if (!resourceType || !action) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Missing type or action field' }));
				return [];
			}

			// Team filter: if configured, only accept events for the specified team
			if (this.teamFilter) {
				const data = payload.data as Record<string, unknown> | undefined;
				const team = data?.team as Record<string, unknown> | undefined;
				const teamKey = team?.key as string | undefined;
				if (teamKey && teamKey !== this.teamFilter) {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: true, filtered: true, reason: 'team_mismatch' }));
					return [];
				}
			}

			const events = this.normalizeWebhookPayload(resourceType, action, payload);

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
	 * Normalize a Linear webhook payload into OrgLoop events.
	 * Uses the same normalizer functions as the polling connector to produce
	 * identical event shapes.
	 */
	normalizeWebhookPayload(
		resourceType: string,
		action: string,
		payload: Record<string, unknown>,
	): OrgLoopEvent[] {
		const data = payload.data as Record<string, unknown> | undefined;
		if (!data) return [];

		const updatedFrom = payload.updatedFrom as Record<string, unknown> | undefined;

		switch (resourceType) {
			case 'Issue': {
				if (!this.isEventAllowed('Issue')) return [];
				return this.normalizeIssueEvent(action, data, updatedFrom);
			}

			case 'Comment': {
				if (!this.isEventAllowed('Comment')) return [];
				if (action !== 'create') return this.buildRawEvent(resourceType, action, payload);
				return this.normalizeCommentEvent(data);
			}

			default:
				return this.buildRawEvent(resourceType, action, payload);
		}
	}

	private normalizeIssueEvent(
		action: string,
		data: Record<string, unknown>,
		updatedFrom?: Record<string, unknown>,
	): OrgLoopEvent[] {
		if (action === 'create') {
			return [
				normalizeNewIssue(this.sourceId, {
					id: data.id as string,
					identifier: data.identifier as string,
					title: data.title as string,
					description: data.description as string | null,
					url: data.url as string,
					state: { name: resolveStateName(data.state) },
					creator: data.creator as { name: string; isBot?: boolean } | null,
					createdAt: data.createdAt as string,
				}),
			];
		}

		if (action === 'update' && updatedFrom) {
			const events: OrgLoopEvent[] = [];
			const issueBase = {
				identifier: data.identifier as string,
				title: data.title as string,
				url: data.url as string,
				assignee: data.assignee as { name: string; isBot?: boolean } | null,
				updatedAt: data.updatedAt as string,
			};

			// State change — detect via updatedFrom.state or updatedFrom.stateId
			if (updatedFrom.state !== undefined || updatedFrom.stateId !== undefined) {
				const previousState = resolveStateName(updatedFrom.state, 'Unknown');
				const currentState = resolveStateName(data.state);
				events.push(
					normalizeIssueStateChange(
						this.sourceId,
						{ id: data.id as string, state: { name: currentState }, ...issueBase },
						previousState,
					),
				);
			}

			// Assignee change
			if (updatedFrom.assigneeId !== undefined) {
				const previousAssignee =
					((updatedFrom.assignee as Record<string, unknown>)?.name as string | null) ?? null;
				events.push(normalizeAssigneeChange(this.sourceId, issueBase, previousAssignee));
			}

			// Priority change
			if (updatedFrom.priority !== undefined) {
				events.push(
					normalizePriorityChange(
						this.sourceId,
						issueBase,
						updatedFrom.priority as number,
						data.priority as number,
					),
				);
			}

			// Label change
			if (updatedFrom.labelIds !== undefined) {
				const prevLabels = ((updatedFrom.labels ?? []) as Array<{ name: string }>).map(
					(l) => l.name,
				);
				const newLabels = ((data.labels as Array<{ name: string }>) ?? []).map((l) => l.name);
				events.push(normalizeLabelChange(this.sourceId, issueBase, prevLabels, newLabels));
			}

			if (events.length > 0) return events;
		}

		// Fallback for unrecognized issue actions (remove, etc.)
		return this.buildRawEvent('Issue', action, { data });
	}

	private normalizeCommentEvent(data: Record<string, unknown>): OrgLoopEvent[] {
		const issue = data.issue as Record<string, unknown> | undefined;
		return [
			normalizeComment(
				this.sourceId,
				{
					id: data.id as string,
					body: data.body as string,
					url: data.url as string,
					createdAt: data.createdAt as string,
					user: data.user as { name: string; isBot?: boolean } | null,
				},
				{
					identifier: (issue?.identifier as string) ?? 'unknown',
					title: (issue?.title as string) ?? '',
					assignee: issue?.assignee as { name: string } | null,
					creator: issue?.creator as { name: string } | null,
				},
			),
		];
	}

	private isEventAllowed(eventType: string): boolean {
		if (!this.allowedEvents) return true;
		return this.allowedEvents.has(eventType);
	}

	private buildRawEvent(
		resourceType: string,
		action: string,
		payload: Record<string, unknown>,
	): OrgLoopEvent[] {
		return [
			buildEvent({
				source: this.sourceId,
				type: 'resource.changed',
				provenance: {
					platform: 'linear',
					platform_event: `${resourceType.toLowerCase()}.${action}`,
				},
				payload,
			}),
		];
	}

	private persistEvent(event: OrgLoopEvent): void {
		if (this.bufferPath) {
			appendFileSync(this.bufferPath, `${JSON.stringify(event)}\n`);
		} else {
			this.pendingEvents.push(event);
		}
	}

	private loadBufferedEvents(): OrgLoopEvent[] {
		if (!this.bufferPath || !existsSync(this.bufferPath)) {
			return [];
		}
		const content = readFileSync(this.bufferPath, 'utf-8').trim();
		if (!content) {
			return [];
		}
		return content.split('\n').map((line) => JSON.parse(line) as OrgLoopEvent);
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
