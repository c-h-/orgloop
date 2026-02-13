import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockActor, MockLogger, MockSource, MockTransform, createTestEvent } from '@orgloop/sdk';
import type { OrgLoopConfig, OrgLoopEvent, Transform, TransformContext } from '@orgloop/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { OrgLoop } from '../engine.js';

function makeConfig(overrides?: Partial<OrgLoopConfig>): OrgLoopConfig {
	return {
		project: { name: 'test-project' },
		sources: [
			{
				id: 'test-source',
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
				name: 'test-route',
				when: {
					source: 'test-source',
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

describe('OrgLoop engine integration', () => {
	it('initializes sources and actors on start', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const engine = new OrgLoop(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
		});

		await engine.start();

		expect(source.initialized).toBe(true);
		expect(actor.initialized).toBe(true);

		await engine.stop();
	});

	it('delivers injected events to matching actors', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const engine = new OrgLoop(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
		});

		await engine.start();

		const event = createTestEvent({
			source: 'test-source',
			type: 'resource.changed',
		});

		await engine.inject(event);

		expect(actor.delivered).toHaveLength(1);
		expect(actor.delivered[0].event.source).toBe('test-source');

		await engine.stop();
	});

	it('does not deliver events with no matching route', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const engine = new OrgLoop(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
		});

		await engine.start();

		// Event from a source that doesn't match any route
		const event = createTestEvent({
			source: 'unknown-source',
			type: 'resource.changed',
		});

		await engine.inject(event);

		expect(actor.delivered).toHaveLength(0);

		await engine.stop();
	});

	it('reports status with connector info', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const engine = new OrgLoop(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
		});

		// Before start
		const preStatus = engine.status();
		expect(preStatus.running).toBe(false);
		expect(preStatus.sources).toContain('test-source');
		expect(preStatus.actors).toContain('test-actor');
		expect(preStatus.routes).toBe(1);

		await engine.start();

		const runningStatus = engine.status();
		expect(runningStatus.running).toBe(true);
		expect(runningStatus.uptime_ms).toBeGreaterThanOrEqual(0);

		await engine.stop();
	});

	it('shuts down sources and actors on stop', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const engine = new OrgLoop(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
		});

		await engine.start();
		await engine.stop();

		expect(source.shutdownCalled).toBe(true);
		expect(actor.shutdownCalled).toBe(true);
	});

	it('initializes and invokes loggers on events', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');
		const logger = new MockLogger('test-logger');

		const config = makeConfig({
			loggers: [{ name: 'test-logger', type: 'mock', config: {} }],
		});

		const engine = new OrgLoop(config, {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
			loggers: new Map([['test-logger', logger]]),
		});

		await engine.start();
		expect(logger.initialized).toBe(true);

		const event = createTestEvent({
			source: 'test-source',
			type: 'resource.changed',
		});
		await engine.inject(event);

		// Logger should have received log entries (system.start + event processing)
		expect(logger.entries.length).toBeGreaterThan(0);

		await engine.stop();
		expect(logger.shutdownCalled).toBe(true);
	});

	it('initializes and runs package transforms in pipeline', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');
		const transform = new MockTransform('test-transform');

		const config = makeConfig({
			transforms: [{ name: 'test-transform', type: 'package' }],
			routes: [
				{
					name: 'test-route',
					when: { source: 'test-source', events: ['resource.changed'] },
					transforms: [{ ref: 'test-transform' }],
					then: { actor: 'test-actor' },
				},
			],
		});

		const engine = new OrgLoop(config, {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
			transforms: new Map([['test-transform', transform]]),
		});

		await engine.start();
		expect(transform.initialized).toBe(true);

		const event = createTestEvent({
			source: 'test-source',
			type: 'resource.changed',
		});
		await engine.inject(event);

		// Transform should have processed the event
		expect(transform.processed).toHaveLength(1);
		// Actor should still receive it (transform passes through)
		expect(actor.delivered).toHaveLength(1);

		await engine.stop();
	});

	// ─── Dedup integration (WQ-85 regression) ────────────────────────────────

	it('dedup transform drops duplicate events in the pipeline (WQ-85)', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		// Build a simple dedup transform that tracks seen events by source+type
		// This tests the full pipeline path: source -> transform -> actor
		const seenHashes = new Map<string, number>();

		const dedupTransform: Transform = {
			id: 'test-dedup',
			async init(_config: Record<string, unknown>): Promise<void> {
				// no-op
			},
			async execute(event: OrgLoopEvent, _context: TransformContext): Promise<OrgLoopEvent | null> {
				const key = `${event.source}:${event.type}:${(event.payload as Record<string, unknown>).message_id ?? ''}`;
				const now = Date.now();
				const lastSeen = seenHashes.get(key);
				if (lastSeen !== undefined && now - lastSeen < 300_000) {
					return null; // Drop duplicate
				}
				seenHashes.set(key, now);
				return event;
			},
			async shutdown(): Promise<void> {
				seenHashes.clear();
			},
		};

		const config = makeConfig({
			transforms: [{ name: 'test-dedup', type: 'package' }],
			routes: [
				{
					name: 'dedup-route',
					when: { source: 'test-source', events: ['resource.changed'] },
					transforms: [{ ref: 'test-dedup' }],
					then: { actor: 'test-actor' },
				},
			],
		});

		const engine = new OrgLoop(config, {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
			transforms: new Map([['test-dedup', dedupTransform]]),
		});

		await engine.start();

		// Inject the same "email" event 4 times (simulating duplicate poll emissions)
		for (let i = 0; i < 4; i++) {
			const event = createTestEvent({
				source: 'test-source',
				type: 'resource.changed',
				payload: { message_id: 'msg_abc123', subject: 'Nathan Ellis' },
			});
			await engine.inject(event);
		}

		// Only the first event should have been delivered
		expect(actor.delivered).toHaveLength(1);
		expect(actor.delivered[0].event.payload.message_id).toBe('msg_abc123');

		// A different message_id should still be delivered
		const differentEvent = createTestEvent({
			source: 'test-source',
			type: 'resource.changed',
			payload: { message_id: 'msg_def456', subject: 'Different Email' },
		});
		await engine.inject(differentEvent);
		expect(actor.delivered).toHaveLength(2);

		await engine.stop();
	});

	it('dedup transform that drops all events prevents delivery', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');
		const transform = new MockTransform('drop-all');
		transform.setDrop(true);

		const config = makeConfig({
			transforms: [{ name: 'drop-all', type: 'package' }],
			routes: [
				{
					name: 'drop-route',
					when: { source: 'test-source', events: ['resource.changed'] },
					transforms: [{ ref: 'drop-all' }],
					then: { actor: 'test-actor' },
				},
			],
		});

		const engine = new OrgLoop(config, {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
			transforms: new Map([['drop-all', transform]]),
		});

		await engine.start();

		const event = createTestEvent({
			source: 'test-source',
			type: 'resource.changed',
		});
		await engine.inject(event);

		// Transform dropped it — actor should not receive anything
		expect(actor.delivered).toHaveLength(0);

		await engine.stop();
	});

	// ─── Prompt front matter stripping (WQ-92) ──────────────────────────────

	describe('prompt front matter stripping', () => {
		const tempDir = join(tmpdir(), 'orgloop-test-prompt');
		const promptPath = join(tempDir, 'review-sop.md');

		// Create temp prompt file with front matter
		if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			promptPath,
			[
				'---',
				'title: Review SOP',
				'priority: high',
				'tags:',
				'  - review',
				'  - code',
				'---',
				'You are a senior code reviewer.',
				'',
				'Review the PR carefully.',
			].join('\n'),
		);

		afterAll(() => {
			try {
				unlinkSync(promptPath);
			} catch {
				// ignore cleanup errors
			}
		});

		it('strips front matter from prompt_file and delivers metadata to actor (WQ-92)', async () => {
			const source = new MockSource('test-source');
			const actor = new MockActor('test-actor');

			const config = makeConfig({
				routes: [
					{
						name: 'prompt-route',
						when: { source: 'test-source', events: ['resource.changed'] },
						then: { actor: 'test-actor' },
						with: { prompt_file: promptPath },
					},
				],
			});

			const engine = new OrgLoop(config, {
				sources: new Map([['test-source', source]]),
				actors: new Map([['test-actor', actor]]),
			});

			await engine.start();

			const event = createTestEvent({
				source: 'test-source',
				type: 'resource.changed',
			});
			await engine.inject(event);

			expect(actor.delivered).toHaveLength(1);

			const deliveryConfig = actor.delivered[0].config;

			// launch_prompt should NOT contain front matter delimiters or YAML
			expect(deliveryConfig.launch_prompt).toBe(
				'You are a senior code reviewer.\n\nReview the PR carefully.',
			);
			expect(deliveryConfig.launch_prompt).not.toContain('---');
			expect(deliveryConfig.launch_prompt).not.toContain('title:');

			// launch_prompt_meta should contain parsed YAML metadata
			expect(deliveryConfig.launch_prompt_meta).toEqual({
				title: 'Review SOP',
				priority: 'high',
				tags: ['review', 'code'],
			});

			// launch_prompt_file should reference the original path
			expect(deliveryConfig.launch_prompt_file).toBe(promptPath);

			await engine.stop();
		});
	});
});
