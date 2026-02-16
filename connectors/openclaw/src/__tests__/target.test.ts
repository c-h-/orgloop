import type { RouteDeliveryConfig } from '@orgloop/sdk';
import { createTestEvent } from '@orgloop/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenClawTarget } from '../target.js';

describe('OpenClawTarget', () => {
	let target: OpenClawTarget;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		target = new OpenClawTarget();
		await target.init({
			id: 'openclaw-engineering-agent',
			connector: '@orgloop/connector-openclaw',
			config: {
				base_url: 'http://localhost:18789',
				agent_id: 'test-agent',
			},
		});

		fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
		});
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('sends correct OpenClaw payload shape', async () => {
		const event = createTestEvent({
			source: 'github',
			type: 'resource.changed',
			provenance: {
				platform: 'github',
				platform_event: 'pull_request.review_submitted',
				author: 'alice',
				author_type: 'team_member',
			},
			payload: { pr_number: 42 },
		});

		const routeConfig: RouteDeliveryConfig = {
			session_key: 'hook:github:pr-review:engineering',
			wake_mode: 'now',
			deliver: true,
			launch_prompt: 'Review this PR',
		};

		const result = await target.deliver(event, routeConfig);
		expect(result.status).toBe('delivered');

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('http://localhost:18789/hooks/agent');

		const body = JSON.parse(opts.body);

		// Assert correct fields present
		expect(body).toHaveProperty('message');
		expect(body).toHaveProperty('sessionKey', 'hook:github:pr-review:engineering');
		expect(body).toHaveProperty('agentId', 'test-agent');
		expect(body).toHaveProperty('wakeMode', 'now');
		expect(body).toHaveProperty('deliver', true);

		// Assert old fields are NOT present
		expect(body).not.toHaveProperty('event');
		expect(body).not.toHaveProperty('launch_prompt');
		expect(body).not.toHaveProperty('agent_id');

		// Assert message contains event context and payload values
		expect(body.message).toContain('github');
		expect(body.message).toContain('resource.changed');
		expect(body.message).toContain('Review this PR');
		expect(body.message).toContain('pr_number: 42');
		expect(body.message).toContain('Instructions:');
	});

	it('generates fallback sessionKey from event', async () => {
		const event = createTestEvent({
			source: 'linear',
			type: 'resource.changed',
		});

		const routeConfig: RouteDeliveryConfig = {};

		await target.deliver(event, routeConfig);

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.sessionKey).toBe('orgloop:linear:resource.changed');
	});

	it('includes platform_event and author in message', async () => {
		const event = createTestEvent({
			source: 'github',
			type: 'resource.changed',
			provenance: {
				platform: 'github',
				platform_event: 'pull_request.merged',
				author: 'bob',
				author_type: 'team_member',
			},
		});

		await target.deliver(event, {});

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.message).toContain('pull_request.merged');
		expect(body.message).toContain('bob');
	});

	it('includes full payload values and provenance context in message', async () => {
		const event = createTestEvent({
			source: 'linear',
			type: 'resource.changed',
			provenance: {
				platform: 'linear',
				platform_event: 'comment.created',
				author: 'Alice',
				author_type: 'team_member',
				issue_id: 'ENG-42',
				url: 'https://linear.app/team/issue/ENG-42#comment-abc',
			},
			payload: {
				action: 'comment_created',
				issue_id: 'ENG-42',
				issue_title: 'Fix the widget',
				comment_body: 'This needs a different approach — see the RFC.',
			},
		});

		await target.deliver(event, { launch_prompt: 'Handle this Linear activity' });

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		const msg = body.message;

		// Header
		expect(msg).toContain('[linear] resource.changed (comment.created) by Alice');

		// Provenance context (url, issue_id — not platform/author which are in header)
		expect(msg).toContain('issue_id: ENG-42');
		expect(msg).toContain('url: https://linear.app/team/issue/ENG-42#comment-abc');

		// Payload values — the actual data the LLM needs
		expect(msg).toContain('issue_title: Fix the widget');
		expect(msg).toContain('comment_body: This needs a different approach — see the RFC.');

		// Instructions
		expect(msg).toContain('Handle this Linear activity');
	});

	it('defaults wakeMode to "now"', async () => {
		const event = createTestEvent();
		await target.deliver(event, {});

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.wakeMode).toBe('now');
	});

	it('defaults deliver to false', async () => {
		const event = createTestEvent();
		await target.deliver(event, {});

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.deliver).toBe(false);
	});

	it('handles 429 rate limit', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 429,
			statusText: 'Too Many Requests',
		});

		const event = createTestEvent();
		const result = await target.deliver(event, {});

		expect(result.status).toBe('error');
		expect(result.error?.message).toContain('429');
	});

	it('handles 4xx rejection', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 400,
			statusText: 'Bad Request',
		});

		const event = createTestEvent();
		const result = await target.deliver(event, {});

		expect(result.status).toBe('rejected');
	});
});
