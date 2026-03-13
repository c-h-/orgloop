import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LinearWebhookSource } from '../source.js';

const TEST_SECRET = 'test-linear-webhook-secret';

function createMockRequest(
	body: string,
	method = 'POST',
	headers: Record<string, string> = {},
): IncomingMessage {
	const req = new EventEmitter() as unknown as IncomingMessage;
	req.method = method;
	req.headers = { ...headers };
	setTimeout(() => {
		(req as EventEmitter).emit('data', Buffer.from(body));
		(req as EventEmitter).emit('end');
	}, 0);
	return req;
}

function createMockResponse(): ServerResponse & { statusCode: number; body: string } {
	const res = {
		statusCode: 200,
		body: '',
		writeHead(code: number, _headers?: Record<string, string>) {
			res.statusCode = code;
			return res;
		},
		end(data?: string) {
			res.body = data ?? '';
			return res;
		},
	} as unknown as ServerResponse & { statusCode: number; body: string };
	return res;
}

function signPayload(body: string, secret: string): string {
	return createHmac('sha256', secret).update(body).digest('hex');
}

// ─── Sample Linear webhook payloads ──────────────────────────────────────────

const sampleIssueCreated = {
	action: 'create',
	createdAt: '2024-01-15T10:00:00.000Z',
	type: 'Issue',
	url: 'https://linear.app/team/issue/TEAM-42',
	data: {
		id: 'issue-uuid-1',
		identifier: 'TEAM-42',
		title: 'Fix login bug',
		description: 'Login fails on mobile',
		url: 'https://linear.app/team/issue/TEAM-42',
		state: { name: 'Todo' },
		creator: { name: 'Alice', isBot: false },
		assignee: { name: 'Bob', isBot: false },
		createdAt: '2024-01-15T10:00:00.000Z',
		updatedAt: '2024-01-15T10:00:00.000Z',
		priority: 2,
		labels: [],
		team: { key: 'TEAM' },
	},
};

const sampleIssueStateChanged = {
	action: 'update',
	createdAt: '2024-01-15T11:00:00.000Z',
	type: 'Issue',
	url: 'https://linear.app/team/issue/TEAM-42',
	updatedFrom: {
		state: { name: 'Todo' },
	},
	data: {
		id: 'issue-uuid-1',
		identifier: 'TEAM-42',
		title: 'Fix login bug',
		url: 'https://linear.app/team/issue/TEAM-42',
		state: { name: 'In Progress' },
		assignee: { name: 'Bob', isBot: false },
		creator: { name: 'Alice', isBot: false },
		createdAt: '2024-01-15T10:00:00.000Z',
		updatedAt: '2024-01-15T11:00:00.000Z',
		priority: 2,
		labels: [],
		team: { key: 'TEAM' },
	},
};

const sampleIssueAssigneeChanged = {
	action: 'update',
	createdAt: '2024-01-15T12:00:00.000Z',
	type: 'Issue',
	url: 'https://linear.app/team/issue/TEAM-42',
	updatedFrom: {
		assigneeId: 'old-user-id',
		assignee: { name: 'Bob' },
	},
	data: {
		id: 'issue-uuid-1',
		identifier: 'TEAM-42',
		title: 'Fix login bug',
		url: 'https://linear.app/team/issue/TEAM-42',
		state: { name: 'In Progress' },
		assignee: { name: 'Carol', isBot: false },
		creator: { name: 'Alice', isBot: false },
		createdAt: '2024-01-15T10:00:00.000Z',
		updatedAt: '2024-01-15T12:00:00.000Z',
		priority: 2,
		labels: [],
		team: { key: 'TEAM' },
	},
};

const sampleIssuePriorityChanged = {
	action: 'update',
	createdAt: '2024-01-15T13:00:00.000Z',
	type: 'Issue',
	url: 'https://linear.app/team/issue/TEAM-42',
	updatedFrom: {
		priority: 2,
	},
	data: {
		id: 'issue-uuid-1',
		identifier: 'TEAM-42',
		title: 'Fix login bug',
		url: 'https://linear.app/team/issue/TEAM-42',
		state: { name: 'In Progress' },
		assignee: { name: 'Bob', isBot: false },
		createdAt: '2024-01-15T10:00:00.000Z',
		updatedAt: '2024-01-15T13:00:00.000Z',
		priority: 1,
		labels: [],
		team: { key: 'TEAM' },
	},
};

const sampleIssueLabelChanged = {
	action: 'update',
	createdAt: '2024-01-15T14:00:00.000Z',
	type: 'Issue',
	url: 'https://linear.app/team/issue/TEAM-42',
	updatedFrom: {
		labelIds: ['label-1'],
		labels: [{ name: 'bug' }],
	},
	data: {
		id: 'issue-uuid-1',
		identifier: 'TEAM-42',
		title: 'Fix login bug',
		url: 'https://linear.app/team/issue/TEAM-42',
		state: { name: 'In Progress' },
		assignee: { name: 'Bob', isBot: false },
		createdAt: '2024-01-15T10:00:00.000Z',
		updatedAt: '2024-01-15T14:00:00.000Z',
		priority: 2,
		labels: [{ name: 'bug' }, { name: 'urgent' }],
		team: { key: 'TEAM' },
	},
};

const sampleCommentCreated = {
	action: 'create',
	createdAt: '2024-01-15T11:30:00.000Z',
	type: 'Comment',
	url: 'https://linear.app/team/issue/TEAM-42#comment-1',
	data: {
		id: 'comment-uuid-1',
		body: 'I can reproduce this on iOS 17',
		url: 'https://linear.app/team/issue/TEAM-42#comment-1',
		createdAt: '2024-01-15T11:30:00.000Z',
		user: { name: 'Alice', isBot: false },
		issue: {
			identifier: 'TEAM-42',
			title: 'Fix login bug',
			assignee: { name: 'Bob' },
			creator: { name: 'Alice' },
		},
	},
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LinearWebhookSource', () => {
	let source: LinearWebhookSource;

	beforeEach(() => {
		source = new LinearWebhookSource();
	});

	afterEach(async () => {
		await source.shutdown();
	});

	// ─── Initialization ──────────────────────────────────────────────────────

	it('initializes without error', async () => {
		await source.init({
			id: 'linear-wh',
			connector: '@orgloop/connector-linear-webhook',
			config: {},
		});
		expect(source.id).toBe('linear-webhook');
	});

	it('returns empty events on initial poll', async () => {
		await source.init({
			id: 'linear-wh',
			connector: '@orgloop/connector-linear-webhook',
			config: {},
		});
		const result = await source.poll(null);
		expect(result.events).toHaveLength(0);
		expect(result.checkpoint).toBeDefined();
	});

	// ─── Signature validation ────────────────────────────────────────────────

	describe('HMAC signature validation', () => {
		beforeEach(async () => {
			process.env.TEST_LINEAR_WEBHOOK_SECRET = TEST_SECRET;
			await source.init({
				id: 'linear-wh',
				connector: '@orgloop/connector-linear-webhook',
				config: { secret: '${TEST_LINEAR_WEBHOOK_SECRET}' },
			});
		});

		afterEach(() => {
			delete process.env.TEST_LINEAR_WEBHOOK_SECRET;
		});

		it('accepts valid signature', async () => {
			const handler = source.webhook();
			const body = JSON.stringify(sampleIssueCreated);
			const req = createMockRequest(body, 'POST', {
				'linear-signature': signPayload(body, TEST_SECRET),
			});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(res.statusCode).toBe(200);
			expect(events).toHaveLength(1);
		});

		it('rejects missing signature', async () => {
			const handler = source.webhook();
			const body = JSON.stringify(sampleIssueCreated);
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(res.statusCode).toBe(401);
			expect(events).toHaveLength(0);
			expect(JSON.parse(res.body).error).toContain('Missing');
		});

		it('rejects invalid signature', async () => {
			const handler = source.webhook();
			const body = JSON.stringify(sampleIssueCreated);
			const req = createMockRequest(body, 'POST', {
				'linear-signature': 'deadbeef',
			});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(res.statusCode).toBe(401);
			expect(events).toHaveLength(0);
			expect(JSON.parse(res.body).error).toContain('Invalid signature');
		});
	});

	// ─── Request validation ──────────────────────────────────────────────────

	describe('request validation', () => {
		beforeEach(async () => {
			await source.init({
				id: 'linear-wh',
				connector: '@orgloop/connector-linear-webhook',
				config: {},
			});
		});

		it('rejects non-POST requests', async () => {
			const handler = source.webhook();
			const req = createMockRequest('', 'GET', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(res.statusCode).toBe(405);
			expect(events).toHaveLength(0);
		});

		it('rejects invalid JSON', async () => {
			const handler = source.webhook();
			const req = createMockRequest('not-json', 'POST', {});
			const res = createMockResponse();

			await handler(req, res);
			expect(res.statusCode).toBe(400);
			expect(JSON.parse(res.body).error).toContain('Invalid JSON');
		});

		it('rejects payloads without type or action', async () => {
			const handler = source.webhook();
			const body = JSON.stringify({ data: {} });
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			await handler(req, res);
			expect(res.statusCode).toBe(400);
			expect(JSON.parse(res.body).error).toContain('type or action');
		});
	});

	// ─── Issue events ────────────────────────────────────────────────────────

	describe('Issue events', () => {
		beforeEach(async () => {
			await source.init({
				id: 'linear-wh',
				connector: '@orgloop/connector-linear-webhook',
				config: {},
			});
		});

		it('normalizes issue.created', async () => {
			const handler = source.webhook();
			const body = JSON.stringify(sampleIssueCreated);
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(res.statusCode).toBe(200);
			expect(events).toHaveLength(1);
			expect(events[0].type).toBe('resource.changed');
			expect(events[0].provenance.platform).toBe('linear');
			expect(events[0].provenance.platform_event).toBe('issue.created');
			expect(events[0].provenance.issue_id).toBe('TEAM-42');
			expect(events[0].payload.action).toBe('issue_created');
			expect(events[0].payload.issue_id).toBe('TEAM-42');
			expect(events[0].payload.issue_title).toBe('Fix login bug');
		});

		it('normalizes issue state change', async () => {
			const handler = source.webhook();
			const body = JSON.stringify(sampleIssueStateChanged);
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(events).toHaveLength(1);
			expect(events[0].provenance.platform_event).toBe('issue.state_changed');
			expect(events[0].payload.action).toBe('state_changed');
			expect(events[0].payload.previous_state).toBe('Todo');
			expect(events[0].payload.new_state).toBe('In Progress');
		});

		it('normalizes issue assignee change', async () => {
			const handler = source.webhook();
			const body = JSON.stringify(sampleIssueAssigneeChanged);
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(events).toHaveLength(1);
			expect(events[0].provenance.platform_event).toBe('issue.assignee_changed');
			expect(events[0].payload.action).toBe('assignee_changed');
			expect(events[0].payload.previous_assignee).toBe('Bob');
			expect(events[0].payload.new_assignee).toBe('Carol');
		});

		it('normalizes issue priority change', async () => {
			const handler = source.webhook();
			const body = JSON.stringify(sampleIssuePriorityChanged);
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(events).toHaveLength(1);
			expect(events[0].provenance.platform_event).toBe('issue.priority_changed');
			expect(events[0].payload.action).toBe('priority_changed');
			expect(events[0].payload.previous_priority).toBe(2);
			expect(events[0].payload.new_priority).toBe(1);
		});

		it('normalizes issue label change', async () => {
			const handler = source.webhook();
			const body = JSON.stringify(sampleIssueLabelChanged);
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(events).toHaveLength(1);
			expect(events[0].provenance.platform_event).toBe('issue.labels_changed');
			expect(events[0].payload.action).toBe('labels_changed');
			expect(events[0].payload.added_labels).toContain('urgent');
		});

		it('emits raw event for issue removal', async () => {
			const handler = source.webhook();
			const body = JSON.stringify({
				action: 'remove',
				type: 'Issue',
				data: { id: 'issue-uuid-1', identifier: 'TEAM-42' },
			});
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(events).toHaveLength(1);
			expect(events[0].provenance.platform_event).toBe('issue.remove');
		});
	});

	// ─── Comment events ──────────────────────────────────────────────────────

	describe('Comment events', () => {
		beforeEach(async () => {
			await source.init({
				id: 'linear-wh',
				connector: '@orgloop/connector-linear-webhook',
				config: {},
			});
		});

		it('normalizes comment.created', async () => {
			const handler = source.webhook();
			const body = JSON.stringify(sampleCommentCreated);
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(events).toHaveLength(1);
			expect(events[0].type).toBe('resource.changed');
			expect(events[0].provenance.platform).toBe('linear');
			expect(events[0].provenance.platform_event).toBe('comment.created');
			expect(events[0].provenance.author).toBe('Alice');
			expect(events[0].provenance.issue_id).toBe('TEAM-42');
			expect(events[0].payload.action).toBe('comment_created');
			expect(events[0].payload.comment_body).toBe('I can reproduce this on iOS 17');
		});

		it('emits raw event for comment update', async () => {
			const handler = source.webhook();
			const body = JSON.stringify({
				action: 'update',
				type: 'Comment',
				data: { id: 'comment-uuid-1', body: 'Updated body' },
			});
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(events).toHaveLength(1);
			expect(events[0].provenance.platform_event).toBe('comment.update');
		});
	});

	// ─── Event filtering ─────────────────────────────────────────────────────

	describe('event filtering', () => {
		it('only accepts configured resource types', async () => {
			await source.init({
				id: 'linear-wh',
				connector: '@orgloop/connector-linear-webhook',
				config: { events: ['Issue'] },
			});

			const handler = source.webhook();

			// Allowed: Issue
			const body1 = JSON.stringify(sampleIssueCreated);
			const req1 = createMockRequest(body1, 'POST', {});
			const res1 = createMockResponse();
			const events1 = await handler(req1, res1);
			expect(events1).toHaveLength(1);

			// Blocked: Comment
			const body2 = JSON.stringify(sampleCommentCreated);
			const req2 = createMockRequest(body2, 'POST', {});
			const res2 = createMockResponse();
			const events2 = await handler(req2, res2);
			expect(events2).toHaveLength(0);
		});

		it('accepts all events when no filter is configured', async () => {
			await source.init({
				id: 'linear-wh',
				connector: '@orgloop/connector-linear-webhook',
				config: {},
			});

			const handler = source.webhook();
			const body = JSON.stringify(sampleCommentCreated);
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(events).toHaveLength(1);
		});
	});

	// ─── Team filtering ──────────────────────────────────────────────────────

	describe('team filtering', () => {
		it('accepts events for the configured team', async () => {
			await source.init({
				id: 'linear-wh',
				connector: '@orgloop/connector-linear-webhook',
				config: { team: 'TEAM' },
			});

			const handler = source.webhook();
			const body = JSON.stringify(sampleIssueCreated);
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(events).toHaveLength(1);
		});

		it('rejects events for a different team', async () => {
			await source.init({
				id: 'linear-wh',
				connector: '@orgloop/connector-linear-webhook',
				config: { team: 'OTHER' },
			});

			const handler = source.webhook();
			const body = JSON.stringify(sampleIssueCreated);
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(res.statusCode).toBe(200);
			expect(events).toHaveLength(0);
			expect(JSON.parse(res.body).filtered).toBe(true);
		});
	});

	// ─── Unknown event types ─────────────────────────────────────────────────

	describe('unknown event types', () => {
		beforeEach(async () => {
			await source.init({
				id: 'linear-wh',
				connector: '@orgloop/connector-linear-webhook',
				config: {},
			});
		});

		it('emits raw events for unknown resource types', async () => {
			const handler = source.webhook();
			const body = JSON.stringify({
				action: 'create',
				type: 'Project',
				data: { id: 'project-1', name: 'New Project' },
			});
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(events).toHaveLength(1);
			expect(events[0].provenance.platform).toBe('linear');
			expect(events[0].provenance.platform_event).toBe('project.create');
			expect(events[0].type).toBe('resource.changed');
		});
	});

	// ─── Poll draining ───────────────────────────────────────────────────────

	describe('poll drains webhook buffer', () => {
		beforeEach(async () => {
			await source.init({
				id: 'linear-wh',
				connector: '@orgloop/connector-linear-webhook',
				config: {},
			});
		});

		it('poll returns events received via webhook', async () => {
			const handler = source.webhook();
			const body = JSON.stringify(sampleIssueCreated);
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			await handler(req, res);

			const result = await source.poll(null);
			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('issue.created');

			// Second poll returns empty
			const result2 = await source.poll(result.checkpoint);
			expect(result2.events).toHaveLength(0);
		});
	});

	// ─── Buffer persistence ──────────────────────────────────────────────────

	describe('buffer persistence', () => {
		let bufferDir: string;

		beforeEach(() => {
			bufferDir = join(tmpdir(), `orgloop-linear-webhook-test-${Date.now()}`);
			mkdirSync(bufferDir, { recursive: true });
		});

		afterEach(() => {
			if (existsSync(bufferDir)) {
				rmSync(bufferDir, { recursive: true });
			}
		});

		it('persists events to disk when buffer_dir is set', async () => {
			await source.init({
				id: 'linear-wh',
				connector: '@orgloop/connector-linear-webhook',
				config: { buffer_dir: bufferDir },
			});

			const handler = source.webhook();
			const body = JSON.stringify(sampleIssueCreated);
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			await handler(req, res);

			// Create a new source instance to verify persistence
			const source2 = new LinearWebhookSource();
			await source2.init({
				id: 'linear-wh',
				connector: '@orgloop/connector-linear-webhook',
				config: { buffer_dir: bufferDir },
			});

			const result = await source2.poll(null);
			expect(result.events).toHaveLength(1);
			expect(result.events[0].provenance.platform_event).toBe('issue.created');
			await source2.shutdown();
		});
	});

	// ─── Event structure ─────────────────────────────────────────────────────

	describe('event structure', () => {
		beforeEach(async () => {
			await source.init({
				id: 'linear-wh',
				connector: '@orgloop/connector-linear-webhook',
				config: {},
			});
		});

		it('produces well-formed OrgLoop events', async () => {
			const handler = source.webhook();
			const body = JSON.stringify(sampleIssueCreated);
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(events).toHaveLength(1);
			const event = events[0];
			expect(event.id).toMatch(/^evt_/);
			expect(event.trace_id).toMatch(/^trc_/);
			expect(event.timestamp).toBeDefined();
			expect(event.source).toBe('linear-wh');
			expect(event.type).toBe('resource.changed');
			expect(event.provenance.platform).toBe('linear');
		});

		it('response includes event IDs', async () => {
			const handler = source.webhook();
			const body = JSON.stringify(sampleIssueCreated);
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			await handler(req, res);
			const responseBody = JSON.parse(res.body);
			expect(responseBody.ok).toBe(true);
			expect(responseBody.events_created).toBe(1);
			expect(responseBody.event_ids).toHaveLength(1);
			expect(responseBody.event_ids[0]).toMatch(/^evt_/);
		});
	});

	// ─── State normalization edge cases ─────────────────────────────────────

	describe('state normalization edge cases', () => {
		beforeEach(async () => {
			await source.init({
				id: 'linear-wh',
				connector: '@orgloop/connector-linear-webhook',
				config: {},
			});
		});

		it('handles state as object with id/name/type (real webhook shape)', async () => {
			const handler = source.webhook();
			const body = JSON.stringify({
				action: 'update',
				type: 'Issue',
				url: 'https://linear.app/team/issue/TEAM-42',
				updatedFrom: {
					state: { id: 'state-uuid-old', name: 'Backlog', type: 'backlog' },
				},
				data: {
					id: 'issue-uuid-1',
					identifier: 'TEAM-42',
					title: 'Fix login bug',
					url: 'https://linear.app/team/issue/TEAM-42',
					state: { id: 'state-uuid-new', name: 'Todo', type: 'unstarted' },
					assignee: null,
					updatedAt: '2024-01-15T11:00:00.000Z',
				},
			});
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(events).toHaveLength(1);
			expect(events[0].payload.previous_state).toBe('Backlog');
			expect(events[0].payload.new_state).toBe('Todo');
		});

		it('handles updatedFrom with only stateId (no state object)', async () => {
			const handler = source.webhook();
			const body = JSON.stringify({
				action: 'update',
				type: 'Issue',
				url: 'https://linear.app/team/issue/TEAM-42',
				updatedFrom: {
					stateId: 'old-state-uuid',
				},
				data: {
					id: 'issue-uuid-1',
					identifier: 'TEAM-42',
					title: 'Fix login bug',
					url: 'https://linear.app/team/issue/TEAM-42',
					state: { id: 'state-uuid-new', name: 'In Progress', type: 'started' },
					assignee: null,
					updatedAt: '2024-01-15T11:00:00.000Z',
				},
			});
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(events).toHaveLength(1);
			expect(events[0].provenance.platform_event).toBe('issue.state_changed');
			expect(events[0].payload.new_state).toBe('In Progress');
			expect(events[0].payload.previous_state).toBe('Unknown');
		});

		it('handles state as plain string', async () => {
			const handler = source.webhook();
			const body = JSON.stringify({
				action: 'update',
				type: 'Issue',
				url: 'https://linear.app/team/issue/TEAM-42',
				updatedFrom: {
					state: 'Backlog',
				},
				data: {
					id: 'issue-uuid-1',
					identifier: 'TEAM-42',
					title: 'Fix login bug',
					url: 'https://linear.app/team/issue/TEAM-42',
					state: 'Done',
					assignee: null,
					updatedAt: '2024-01-15T11:00:00.000Z',
				},
			});
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(events).toHaveLength(1);
			expect(events[0].payload.previous_state).toBe('Backlog');
			expect(events[0].payload.new_state).toBe('Done');
		});

		it('uses Unknown fallback when state name is missing from object', async () => {
			const handler = source.webhook();
			const body = JSON.stringify({
				action: 'create',
				type: 'Issue',
				url: 'https://linear.app/team/issue/TEAM-99',
				data: {
					id: 'issue-uuid-2',
					identifier: 'TEAM-99',
					title: 'Orphan issue',
					description: null,
					url: 'https://linear.app/team/issue/TEAM-99',
					state: { id: 'state-uuid-only' },
					creator: null,
					createdAt: '2024-01-15T10:00:00.000Z',
				},
			});
			const req = createMockRequest(body, 'POST', {});
			const res = createMockResponse();

			const events = await handler(req, res);
			expect(events).toHaveLength(1);
			expect(events[0].provenance.state).toBe('Unknown');
		});
	});

	// ─── normalizeWebhookPayload direct tests ────────────────────────────────

	describe('normalizeWebhookPayload', () => {
		beforeEach(async () => {
			await source.init({
				id: 'linear-wh',
				connector: '@orgloop/connector-linear-webhook',
				config: {},
			});
		});

		it('returns empty for missing data field', () => {
			const events = source.normalizeWebhookPayload('Issue', 'create', {});
			expect(events).toHaveLength(0);
		});

		it('handles update without updatedFrom as raw event', () => {
			const events = source.normalizeWebhookPayload('Issue', 'update', {
				data: { id: 'issue-1', identifier: 'TEAM-1' },
			});
			expect(events).toHaveLength(1);
			expect(events[0].provenance.platform_event).toBe('issue.update');
		});

		it('produces identical event shape as polling connector for issue.created', () => {
			const events = source.normalizeWebhookPayload('Issue', 'create', sampleIssueCreated);
			expect(events).toHaveLength(1);
			const event = events[0];
			// These fields match what the polling connector produces via normalizeNewIssue
			expect(event.provenance.platform).toBe('linear');
			expect(event.provenance.platform_event).toBe('issue.created');
			expect(event.provenance.author).toBe('Alice');
			expect(event.provenance.author_type).toBe('team_member');
			expect(event.provenance.issue_id).toBe('TEAM-42');
			expect(event.provenance.state).toBe('Todo');
			expect(event.payload.action).toBe('issue_created');
			expect(event.payload.issue_id).toBe('TEAM-42');
			expect(event.payload.issue_title).toBe('Fix login bug');
			expect(event.payload.issue_description).toBe('Login fails on mobile');
		});

		it('produces identical event shape as polling connector for comment.created', () => {
			const events = source.normalizeWebhookPayload('Comment', 'create', sampleCommentCreated);
			expect(events).toHaveLength(1);
			const event = events[0];
			expect(event.provenance.platform).toBe('linear');
			expect(event.provenance.platform_event).toBe('comment.created');
			expect(event.provenance.author).toBe('Alice');
			expect(event.provenance.issue_id).toBe('TEAM-42');
			expect(event.provenance.issue_assignee).toBe('Bob');
			expect(event.provenance.issue_creator).toBe('Alice');
			expect(event.payload.action).toBe('comment_created');
			expect(event.payload.comment_body).toBe('I can reproduce this on iOS 17');
		});
	});
});
