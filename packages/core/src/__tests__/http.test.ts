import http from 'node:http';
import type { OrgLoopConfig, OrgLoopEvent, WebhookHandler } from '@orgloop/sdk';
import { createTestEvent, MockActor, MockSource } from '@orgloop/sdk';
import { describe, expect, it } from 'vitest';
import { WebhookServer } from '../http.js';
import { Runtime } from '../runtime.js';

// ─── Helper: make an HTTP request ────────────────────────────────────────────

function request(
	port: number,
	method: string,
	path: string,
	body?: string,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: '127.0.0.1',
				port,
				method,
				path,
				headers: { 'Content-Type': 'application/json' },
			},
			(res) => {
				let data = '';
				res.on('data', (chunk) => {
					data += chunk;
				});
				res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
			},
		);
		req.on('error', reject);
		if (body) req.write(body);
		req.end();
	});
}

// ─── Helper: pick a random available port ────────────────────────────────────

function randomPort(): number {
	return 10000 + Math.floor(Math.random() * 50000);
}

// ─── WebhookServer unit tests ────────────────────────────────────────────────

describe('WebhookServer', () => {
	it('starts and stops cleanly', async () => {
		const server = new WebhookServer(async () => {}, new Map());
		const port = randomPort();
		await server.start(port);
		await server.stop();
	});

	it('dispatches POST /webhook/:sourceId to handler and calls onEvent', async () => {
		const testEvent = createTestEvent({ source: 'hook-source' });
		const receivedEvents: OrgLoopEvent[] = [];

		const handler: WebhookHandler = async (_req, res) => {
			res.writeHead(200);
			res.end('ok');
			return [testEvent];
		};

		const handlers = new Map([['hook-source', handler]]);
		const server = new WebhookServer(async (event) => {
			receivedEvents.push(event);
		}, handlers);

		const port = randomPort();
		await server.start(port);

		try {
			const res = await request(port, 'POST', '/webhook/hook-source', '{}');
			expect(res.status).toBe(200);
			expect(res.body).toBe('ok');
			expect(receivedEvents).toHaveLength(1);
			expect(receivedEvents[0].source).toBe('hook-source');
		} finally {
			await server.stop();
		}
	});

	it('returns 404 for unknown sourceId', async () => {
		const handler: WebhookHandler = async (_req, res) => {
			res.writeHead(200);
			res.end('ok');
			return [];
		};

		const handlers = new Map([['known-source', handler]]);
		const server = new WebhookServer(async () => {}, handlers);

		const port = randomPort();
		await server.start(port);

		try {
			const res = await request(port, 'POST', '/webhook/unknown-source', '{}');
			expect(res.status).toBe(404);
			expect(JSON.parse(res.body).error).toContain('unknown-source');
		} finally {
			await server.stop();
		}
	});

	it('returns 405 for non-POST methods', async () => {
		const handler: WebhookHandler = async (_req, res) => {
			res.writeHead(200);
			res.end('ok');
			return [];
		};

		const handlers = new Map([['known-source', handler]]);
		const server = new WebhookServer(async () => {}, handlers);

		const port = randomPort();
		await server.start(port);

		try {
			const res = await request(port, 'GET', '/webhook/known-source');
			expect(res.status).toBe(405);
			expect(JSON.parse(res.body).error).toContain('Method not allowed');
		} finally {
			await server.stop();
		}
	});

	it('returns 404 for paths outside /webhook/:sourceId', async () => {
		const server = new WebhookServer(async () => {}, new Map());

		const port = randomPort();
		await server.start(port);

		try {
			const res = await request(port, 'POST', '/health');
			expect(res.status).toBe(404);
		} finally {
			await server.stop();
		}
	});
});

// ─── Engine integration ──────────────────────────────────────────────────────

/** A mock source with a webhook() method */
class WebhookMockSource extends MockSource {
	private readonly webhookEvents: OrgLoopEvent[];

	constructor(id: string, webhookEvents: OrgLoopEvent[]) {
		super(id);
		this.webhookEvents = webhookEvents;
	}

	webhook(): WebhookHandler {
		const events = this.webhookEvents;
		return async (_req, res) => {
			res.writeHead(200);
			res.end('ok');
			return events;
		};
	}
}

function makeConfig(overrides?: Partial<OrgLoopConfig>): OrgLoopConfig {
	return {
		project: { name: 'test-project' },
		sources: [
			{
				id: 'webhook-source',
				connector: 'mock',
				config: {},
				poll: { interval: '5m' },
			},
		],
		actors: [
			{
				id: 'test-actor',
				connector: 'mock',
				config: {},
			},
		],
		routes: [
			{
				name: 'webhook-route',
				when: {
					source: 'webhook-source',
					events: ['resource.changed'],
				},
				then: {
					actor: 'test-actor',
				},
			},
		],
		transforms: [],
		loggers: [],
		...overrides,
	};
}

describe('Runtime webhook integration', () => {
	it('starts HTTP server for webhook sources and processes events', async () => {
		const testEvent = createTestEvent({ source: 'webhook-source' });
		const webhookSource = new WebhookMockSource('webhook-source', [testEvent]);
		const actor = new MockActor('test-actor');
		const port = randomPort();

		const runtime = Runtime.singleModule(makeConfig(), {
			load: {
				sources: new Map([['webhook-source', webhookSource]]),
				actors: new Map([['test-actor', actor]]),
			},
			runtime: { httpPort: port, crashHandlers: false },
		});

		await runtime.start();

		try {
			const res = await request(port, 'POST', '/webhook/webhook-source', '{}');
			expect(res.status).toBe(200);

			await new Promise((r) => setTimeout(r, 50));

			expect(actor.delivered).toHaveLength(1);
			expect(actor.delivered[0].event.source).toBe('webhook-source');
		} finally {
			await runtime.stop();
		}
	});

	it('webhook source with poll.interval is polled (hybrid mode); without poll.interval is not', async () => {
		const webhookWithPoll = new WebhookMockSource('webhook-source', []);
		const webhookOnly = new WebhookMockSource('webhook-only-source', []);
		const pollSource = new MockSource('poll-source');
		const actor = new MockActor('test-actor');
		const port = randomPort();

		const config = makeConfig({
			sources: [
				{ id: 'webhook-source', connector: 'mock', config: {}, poll: { interval: '5m' } },
				{ id: 'webhook-only-source', connector: 'mock', config: {} },
				{ id: 'poll-source', connector: 'mock', config: {}, poll: { interval: '5m' } },
			],
		});

		const runtime = Runtime.singleModule(config, {
			load: {
				sources: new Map([
					['webhook-source', webhookWithPoll],
					['webhook-only-source', webhookOnly],
					['poll-source', pollSource],
				]),
				actors: new Map([['test-actor', actor]]),
			},
			runtime: { httpPort: port, crashHandlers: false },
		});

		await runtime.start();

		try {
			await new Promise((r) => setTimeout(r, 50));

			expect(pollSource.totalPolls).toBeGreaterThan(0);
			expect(webhookWithPoll.totalPolls).toBeGreaterThan(0);
			expect(webhookOnly.totalPolls).toBe(0);

			const status = runtime.status();
			expect(status.httpPort).toBe(port);
		} finally {
			await runtime.stop();
		}
	});

	it('starts HTTP server unconditionally so the control API is available', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const config = makeConfig({
			sources: [{ id: 'test-source', connector: 'mock', config: {}, poll: { interval: '5m' } }],
			routes: [
				{
					name: 'test-route',
					when: { source: 'test-source', events: ['resource.changed'] },
					then: { actor: 'test-actor' },
				},
			],
		});

		const runtime = Runtime.singleModule(config, {
			load: {
				sources: new Map([['test-source', source]]),
				actors: new Map([['test-actor', actor]]),
			},
			runtime: { crashHandlers: false },
		});

		await runtime.start();

		// Without webhook sources, runtime does not auto-start its HTTP server
		expect(runtime.isHttpStarted()).toBe(false);

		await runtime.stop();
	});
});
