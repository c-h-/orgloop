import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
	OrgLoopConfig,
	OrgLoopEvent,
	PollResult,
	SourceConfig,
	WebhookHandler,
} from '@orgloop/sdk';
import {
	buildEvent,
	createTestEvent,
	MockActor,
	MockLogger,
	MockSource,
	MockTransform,
} from '@orgloop/sdk';
import { describe, expect, it } from 'vitest';
import { OrgLoop } from '../engine.js';

function makeConfig(overrides?: Partial<OrgLoopConfig>): OrgLoopConfig {
	return {
		project: { name: 'pipeline-e2e' },
		sources: [],
		actors: [],
		routes: [],
		transforms: [],
		loggers: [],
		...overrides,
	};
}

describe('E2E pipeline', () => {
	it('multi-source routing — events reach only their matched actor', async () => {
		const sourceA = new MockSource('source-a');
		const sourceB = new MockSource('source-b');
		const actorA = new MockActor('actor-a');
		const actorB = new MockActor('actor-b');

		const config = makeConfig({
			sources: [
				{ id: 'source-a', connector: 'mock', config: {}, poll: { interval: '5m' } },
				{ id: 'source-b', connector: 'mock', config: {}, poll: { interval: '5m' } },
			],
			actors: [
				{ id: 'actor-a', connector: 'mock', config: {} },
				{ id: 'actor-b', connector: 'mock', config: {} },
			],
			routes: [
				{
					name: 'route-a',
					when: { source: 'source-a', events: ['resource.changed'] },
					then: { actor: 'actor-a' },
				},
				{
					name: 'route-b',
					when: { source: 'source-b', events: ['resource.changed'] },
					then: { actor: 'actor-b' },
				},
			],
		});

		const engine = new OrgLoop(config, {
			sources: new Map([
				['source-a', sourceA],
				['source-b', sourceB],
			]),
			actors: new Map([
				['actor-a', actorA],
				['actor-b', actorB],
			]),
		});

		await engine.start();

		const eventA = createTestEvent({ source: 'source-a', type: 'resource.changed' });
		const eventB = createTestEvent({ source: 'source-b', type: 'resource.changed' });

		await engine.inject(eventA);
		await engine.inject(eventB);

		expect(actorA.delivered).toHaveLength(1);
		expect(actorA.delivered[0].event.source).toBe('source-a');

		expect(actorB.delivered).toHaveLength(1);
		expect(actorB.delivered[0].event.source).toBe('source-b');

		await engine.stop();
	});

	it('transform pipeline ordering — transforms execute in sequence', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const order: string[] = [];

		const t1 = new MockTransform('t1');
		t1.setModifier((event) => {
			order.push('t1');
			return { ...event, payload: { ...event.payload, t1: true } };
		});
		const t2 = new MockTransform('t2');
		t2.setModifier((event) => {
			order.push('t2');
			return { ...event, payload: { ...event.payload, t2: true } };
		});
		const t3 = new MockTransform('t3');
		t3.setModifier((event) => {
			order.push('t3');
			return { ...event, payload: { ...event.payload, t3: true } };
		});

		const config = makeConfig({
			sources: [{ id: 'test-source', connector: 'mock', config: {}, poll: { interval: '5m' } }],
			actors: [{ id: 'test-actor', connector: 'mock', config: {} }],
			transforms: [
				{ name: 't1', type: 'package' },
				{ name: 't2', type: 'package' },
				{ name: 't3', type: 'package' },
			],
			routes: [
				{
					name: 'ordered-route',
					when: { source: 'test-source', events: ['resource.changed'] },
					transforms: [{ ref: 't1' }, { ref: 't2' }, { ref: 't3' }],
					then: { actor: 'test-actor' },
				},
			],
		});

		const engine = new OrgLoop(config, {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
			transforms: new Map([
				['t1', t1],
				['t2', t2],
				['t3', t3],
			]),
		});

		await engine.start();

		const event = createTestEvent({ source: 'test-source', type: 'resource.changed' });
		await engine.inject(event);

		expect(order).toEqual(['t1', 't2', 't3']);

		// Actor receives the fully-transformed event with all three markers
		expect(actor.delivered).toHaveLength(1);
		const delivered = actor.delivered[0].event;
		expect(delivered.payload).toMatchObject({ t1: true, t2: true, t3: true });

		await engine.stop();
	});

	it('transform filtering — transform returns null drops the event', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const dropper = new MockTransform('dropper');
		dropper.setDrop(true);

		const config = makeConfig({
			sources: [{ id: 'test-source', connector: 'mock', config: {}, poll: { interval: '5m' } }],
			actors: [{ id: 'test-actor', connector: 'mock', config: {} }],
			transforms: [{ name: 'dropper', type: 'package' }],
			routes: [
				{
					name: 'drop-route',
					when: { source: 'test-source', events: ['resource.changed'] },
					transforms: [{ ref: 'dropper' }],
					then: { actor: 'test-actor' },
				},
			],
		});

		const engine = new OrgLoop(config, {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
			transforms: new Map([['dropper', dropper]]),
		});

		await engine.start();

		const event = createTestEvent({ source: 'test-source', type: 'resource.changed' });
		await engine.inject(event);

		// Transform saw the event
		expect(dropper.processed).toHaveLength(1);
		// Actor never received it
		expect(actor.delivered).toHaveLength(0);

		await engine.stop();
	});

	it('event type filtering — route only matches specified event types', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const config = makeConfig({
			sources: [{ id: 'test-source', connector: 'mock', config: {}, poll: { interval: '5m' } }],
			actors: [{ id: 'test-actor', connector: 'mock', config: {} }],
			routes: [
				{
					name: 'changed-only',
					when: { source: 'test-source', events: ['resource.changed'] },
					then: { actor: 'test-actor' },
				},
			],
		});

		const engine = new OrgLoop(config, {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
		});

		await engine.start();

		const changedEvent = createTestEvent({
			source: 'test-source',
			type: 'resource.changed',
		});
		const stoppedEvent = createTestEvent({
			source: 'test-source',
			type: 'actor.stopped',
		});

		await engine.inject(changedEvent);
		await engine.inject(stoppedEvent);

		// Only the resource.changed event was delivered
		expect(actor.delivered).toHaveLength(1);
		expect(actor.delivered[0].event.type).toBe('resource.changed');

		await engine.stop();
	});

	it('multi-route fan-out — same source, two routes, both actors receive event', async () => {
		const source = new MockSource('shared-source');
		const actorA = new MockActor('actor-a');
		const actorB = new MockActor('actor-b');

		const config = makeConfig({
			sources: [{ id: 'shared-source', connector: 'mock', config: {}, poll: { interval: '5m' } }],
			actors: [
				{ id: 'actor-a', connector: 'mock', config: {} },
				{ id: 'actor-b', connector: 'mock', config: {} },
			],
			routes: [
				{
					name: 'fan-out-a',
					when: { source: 'shared-source', events: ['resource.changed'] },
					then: { actor: 'actor-a' },
				},
				{
					name: 'fan-out-b',
					when: { source: 'shared-source', events: ['resource.changed'] },
					then: { actor: 'actor-b' },
				},
			],
		});

		const engine = new OrgLoop(config, {
			sources: new Map([['shared-source', source]]),
			actors: new Map([
				['actor-a', actorA],
				['actor-b', actorB],
			]),
		});

		await engine.start();

		const event = createTestEvent({ source: 'shared-source', type: 'resource.changed' });
		await engine.inject(event);

		expect(actorA.delivered).toHaveLength(1);
		expect(actorB.delivered).toHaveLength(1);
		// Both received the same event
		expect(actorA.delivered[0].event.id).toBe(event.id);
		expect(actorB.delivered[0].event.id).toBe(event.id);

		await engine.stop();
	});

	it('actor.stopped feedback loop — delivery triggers supervisor via second route', async () => {
		const workerSource = new MockSource('worker-source');
		const worker = new MockActor('worker');
		const supervisor = new MockActor('supervisor');

		const config = makeConfig({
			sources: [
				{ id: 'worker-source', connector: 'mock', config: {}, poll: { interval: '5m' } },
				// The actor.stopped events are injected as if from the worker actor ID
				{ id: 'worker', connector: 'mock', config: {}, poll: { interval: '5m' } },
			],
			actors: [
				{ id: 'worker', connector: 'mock', config: {} },
				{ id: 'supervisor', connector: 'mock', config: {} },
			],
			routes: [
				{
					name: 'work-route',
					when: { source: 'worker-source', events: ['resource.changed'] },
					then: { actor: 'worker' },
				},
				{
					name: 'supervise-route',
					when: { source: 'worker', events: ['actor.stopped'] },
					then: { actor: 'supervisor' },
				},
			],
		});

		const engine = new OrgLoop(config, {
			sources: new Map([
				['worker-source', workerSource],
				['worker', new MockSource('worker')],
			]),
			actors: new Map([
				['worker', worker],
				['supervisor', supervisor],
			]),
		});

		await engine.start();

		// Step 1: deliver work event to worker
		const workEvent = createTestEvent({
			source: 'worker-source',
			type: 'resource.changed',
		});
		await engine.inject(workEvent);
		expect(worker.delivered).toHaveLength(1);

		// Step 2: simulate actor.stopped feedback (as if the worker finished)
		const stoppedEvent = createTestEvent({
			source: 'worker',
			type: 'actor.stopped',
			payload: {
				actor_id: 'worker',
				exit_code: 0,
				summary: 'Task completed',
			},
		});
		await engine.inject(stoppedEvent);

		// Supervisor should receive the actor.stopped event
		expect(supervisor.delivered).toHaveLength(1);
		expect(supervisor.delivered[0].event.type).toBe('actor.stopped');
		expect(supervisor.delivered[0].event.source).toBe('worker');

		// Worker should NOT receive the actor.stopped (no route for that)
		expect(worker.delivered).toHaveLength(1); // still just the original work event

		await engine.stop();
	});

	it('logger receives all pipeline phases — source.emit, route.match, deliver.attempt, deliver.success', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');
		const logger = new MockLogger('phase-logger');

		const config = makeConfig({
			sources: [{ id: 'test-source', connector: 'mock', config: {}, poll: { interval: '5m' } }],
			actors: [{ id: 'test-actor', connector: 'mock', config: {} }],
			routes: [
				{
					name: 'phase-route',
					when: { source: 'test-source', events: ['resource.changed'] },
					then: { actor: 'test-actor' },
				},
			],
			loggers: [{ name: 'phase-logger', type: 'mock', config: {} }],
		});

		const engine = new OrgLoop(config, {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
			loggers: new Map([['phase-logger', logger]]),
		});

		await engine.start();

		const event = createTestEvent({
			source: 'test-source',
			type: 'resource.changed',
		});
		await engine.inject(event);

		// Verify all four pipeline phases were logged for this event
		const eventEntries = logger.entriesForEvent(event.id);
		const phases = eventEntries.map((e) => e.phase);

		expect(phases).toContain('source.emit');
		expect(phases).toContain('route.match');
		expect(phases).toContain('deliver.attempt');
		expect(phases).toContain('deliver.success');

		// Verify source.emit has the right source
		const emitEntry = eventEntries.find((e) => e.phase === 'source.emit');
		expect(emitEntry?.source).toBe('test-source');
		expect(emitEntry?.event_type).toBe('resource.changed');

		// Verify route.match has route and target
		const matchEntry = eventEntries.find((e) => e.phase === 'route.match');
		expect(matchEntry?.route).toBe('phase-route');
		expect(matchEntry?.target).toBe('test-actor');

		// Verify deliver.attempt and deliver.success reference the actor
		const attemptEntry = eventEntries.find((e) => e.phase === 'deliver.attempt');
		expect(attemptEntry?.target).toBe('test-actor');
		const successEntry = eventEntries.find((e) => e.phase === 'deliver.success');
		expect(successEntry?.target).toBe('test-actor');
		expect(successEntry?.duration_ms).toBeGreaterThanOrEqual(0);

		// All entries share the same trace_id
		const traceIds = new Set(eventEntries.map((e) => e.trace_id));
		expect(traceIds.size).toBe(1);

		await engine.stop();
	});

	it('webhook source — HTTP POST flows through pipeline to actor', async () => {
		// Create a webhook-capable source (MockSource doesn't have webhook())
		const webhookEvents: OrgLoopEvent[] = [];
		const webhookSource = {
			id: 'webhook-src',
			initialized: false,
			shutdownCalled: false,
			async init(_config: SourceConfig): Promise<void> {
				this.initialized = true;
			},
			async poll(_checkpoint: string | null): Promise<PollResult> {
				return { events: [], checkpoint: 'none' };
			},
			webhook(): WebhookHandler {
				return async (req: IncomingMessage, res: ServerResponse): Promise<OrgLoopEvent[]> => {
					// Read the POST body
					const chunks: Buffer[] = [];
					for await (const chunk of req) {
						chunks.push(chunk as Buffer);
					}
					const body = JSON.parse(Buffer.concat(chunks).toString());

					const event = buildEvent({
						source: 'webhook-src',
						type: 'resource.changed',
						provenance: { platform: 'webhook-test', author: 'test' },
						payload: body,
					});

					webhookEvents.push(event);

					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: true }));

					return [event];
				};
			},
			async shutdown(): Promise<void> {
				this.shutdownCalled = true;
			},
		};

		const actor = new MockActor('webhook-actor');

		// Use a random high port to avoid conflicts
		const port = 40000 + Math.floor(Math.random() * 10000);

		const config = makeConfig({
			sources: [
				{ id: 'webhook-src', connector: 'webhook-test', config: {}, poll: { interval: '5m' } },
			],
			actors: [{ id: 'webhook-actor', connector: 'mock', config: {} }],
			routes: [
				{
					name: 'webhook-route',
					when: { source: 'webhook-src', events: ['resource.changed'] },
					then: { actor: 'webhook-actor' },
				},
			],
		});

		const engine = new OrgLoop(config, {
			sources: new Map([['webhook-src', webhookSource]]),
			actors: new Map([['webhook-actor', actor]]),
			httpPort: port,
		});

		await engine.start();

		// Verify the webhook server is running
		const status = engine.status();
		expect(status.httpPort).toBe(port);

		// POST an event to the webhook endpoint
		const response = await fetch(`http://127.0.0.1:${port}/webhook/webhook-src`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'test-action', pr: 42 }),
		});

		expect(response.status).toBe(200);
		const responseBody = await response.json();
		expect(responseBody).toEqual({ ok: true });

		// The event should have flowed through to the actor
		expect(actor.delivered).toHaveLength(1);
		expect(actor.delivered[0].event.source).toBe('webhook-src');
		expect(actor.delivered[0].event.type).toBe('resource.changed');
		expect(actor.delivered[0].event.payload).toMatchObject({ action: 'test-action', pr: 42 });

		await engine.stop();
	});
});
