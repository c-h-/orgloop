import type { OrgLoopConfig, SourceHealthState } from '@orgloop/sdk';
import { createTestEvent, MockActor, MockSource } from '@orgloop/sdk';
import { describe, expect, it, vi } from 'vitest';
import { OrgLoop } from '../engine.js';

function getHealth(engine: OrgLoop, sourceId: string): SourceHealthState {
	const h = engine.health().find((s) => s.sourceId === sourceId);
	if (!h) throw new Error(`No health state for ${sourceId}`);
	return h;
}

function makeConfig(overrides?: Partial<OrgLoopConfig>): OrgLoopConfig {
	return {
		project: { name: 'health-test' },
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

describe('Source health tracking', () => {
	it('initializes health state for all sources on start', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const engine = new OrgLoop(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
		});

		await engine.start();

		const health = engine.health();
		expect(health).toHaveLength(1);
		expect(health[0].sourceId).toBe('test-source');
		expect(health[0].status).toBe('healthy');
		expect(health[0].consecutiveErrors).toBe(0);
		expect(health[0].circuitOpen).toBe(false);
		expect(health[0].totalEventsEmitted).toBe(0);

		await engine.stop();
	});

	it('tracks successful polls and event counts', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const engine = new OrgLoop(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
		});

		await engine.start();

		// Inject events (simulates what poll does after processing)
		const event1 = createTestEvent({ source: 'test-source', type: 'resource.changed' });
		const event2 = createTestEvent({ source: 'test-source', type: 'resource.changed' });
		source.addEvents(event1, event2);

		// Trigger a poll manually by accessing private method
		// biome-ignore lint: accessing private for test
		await (engine as any).pollSource('test-source');

		const h = getHealth(engine, 'test-source');
		expect(h.status).toBe('healthy');
		expect(h.totalEventsEmitted).toBe(2);
		expect(h.lastSuccessfulPoll).not.toBeNull();
		expect(h.consecutiveErrors).toBe(0);
		expect(h.lastError).toBeNull();

		await engine.stop();
	});

	it('tracks consecutive errors on poll failure', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		// Make poll throw (also affects the initial scheduler poll)
		vi.spyOn(source, 'poll').mockRejectedValue(new Error('403 Forbidden'));

		const engine = new OrgLoop(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
		});

		// Suppress error events
		engine.on('error', () => {});

		await engine.start();
		// Scheduler fires first poll automatically — wait for it
		await vi.waitFor(() => {
			const h = getHealth(engine, 'test-source');
			expect(h.consecutiveErrors).toBeGreaterThanOrEqual(1);
		});

		let h = getHealth(engine, 'test-source');
		const errorsAfterStart = h.consecutiveErrors;
		expect(h.status).toBe('degraded');
		expect(h.lastError).toBe('403 Forbidden');

		// Another failure
		// biome-ignore lint: accessing private for test
		await (engine as any).pollSource('test-source');

		h = getHealth(engine, 'test-source');
		expect(h.consecutiveErrors).toBe(errorsAfterStart + 1);

		await engine.stop();
	});

	it('resets error count on successful poll after failures', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');
		const pollSpy = vi.spyOn(source, 'poll');

		// First two polls fail (initial scheduler poll + one manual)
		pollSpy.mockRejectedValueOnce(new Error('network error'));
		pollSpy.mockRejectedValueOnce(new Error('network error'));

		const engine = new OrgLoop(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
		});

		engine.on('error', () => {});

		await engine.start();
		// Wait for initial scheduler poll
		await vi.waitFor(() => {
			const h = getHealth(engine, 'test-source');
			expect(h.consecutiveErrors).toBeGreaterThanOrEqual(1);
		});

		// Trigger another failed poll
		// biome-ignore lint: accessing private for test
		await (engine as any).pollSource('test-source');

		let h = getHealth(engine, 'test-source');
		expect(h.consecutiveErrors).toBeGreaterThanOrEqual(2);
		expect(h.status).toBe('degraded');

		// Restore normal behavior — next poll succeeds
		pollSpy.mockRestore();

		// biome-ignore lint: accessing private for test
		await (engine as any).pollSource('test-source');

		h = getHealth(engine, 'test-source');
		expect(h.consecutiveErrors).toBe(0);
		expect(h.status).toBe('healthy');
		expect(h.lastError).toBeNull();
		expect(h.lastSuccessfulPoll).not.toBeNull();

		await engine.stop();
	});

	it('health data is included in engine status', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const engine = new OrgLoop(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
		});

		await engine.start();

		const status = engine.status();
		expect(status.health).toBeDefined();
		expect(status.health).toHaveLength(1);
		expect(status.health?.[0].sourceId).toBe('test-source');

		await engine.stop();
	});

	it('tracks health for multiple sources independently', async () => {
		const source1 = new MockSource('source-1');
		const source2 = new MockSource('source-2');
		const actor = new MockActor('test-actor');

		vi.spyOn(source1, 'poll').mockRejectedValue(new Error('auth failed'));

		const config = makeConfig({
			sources: [
				{ id: 'source-1', connector: 'mock', config: {}, poll: { interval: '5m' } },
				{ id: 'source-2', connector: 'mock', config: {}, poll: { interval: '5m' } },
			],
			routes: [
				{
					name: 'route-1',
					when: { source: 'source-1', events: ['resource.changed'] },
					then: { actor: 'test-actor' },
				},
				{
					name: 'route-2',
					when: { source: 'source-2', events: ['resource.changed'] },
					then: { actor: 'test-actor' },
				},
			],
		});

		const engine = new OrgLoop(config, {
			sources: new Map([
				['source-1', source1],
				['source-2', source2],
			]),
			actors: new Map([['test-actor', actor]]),
		});

		engine.on('error', () => {});

		await engine.start();
		// Wait for initial scheduler polls to complete
		await vi.waitFor(() => {
			const h1 = getHealth(engine, 'source-1');
			expect(h1.consecutiveErrors).toBeGreaterThanOrEqual(1);
		});

		const h1 = getHealth(engine, 'source-1');
		const h2 = getHealth(engine, 'source-2');

		expect(h1.status).toBe('degraded');
		expect(h1.consecutiveErrors).toBeGreaterThanOrEqual(1);
		expect(h2.status).toBe('healthy');
		expect(h2.consecutiveErrors).toBe(0);

		await engine.stop();
	});
});

describe('Circuit breaker', () => {
	it('opens circuit after N consecutive failures (default: 5)', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		vi.spyOn(source, 'poll').mockRejectedValue(new Error('403 Forbidden'));

		const engine = new OrgLoop(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
		});

		engine.on('error', () => {});

		await engine.start();

		// 5 consecutive failures
		for (let i = 0; i < 5; i++) {
			// biome-ignore lint: accessing private for test
			await (engine as any).pollSource('test-source');
		}

		const h = getHealth(engine, 'test-source');
		expect(h.status).toBe('unhealthy');
		expect(h.circuitOpen).toBe(true);
		expect(h.consecutiveErrors).toBe(5);

		await engine.stop();
	});

	it('respects custom failure threshold', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		vi.spyOn(source, 'poll').mockRejectedValue(new Error('timeout'));

		// Set threshold to 4 to account for the initial scheduler poll
		const engine = new OrgLoop(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
			circuitBreaker: { failureThreshold: 4 },
		});

		engine.on('error', () => {});

		await engine.start();
		// Wait for initial scheduler poll
		await vi.waitFor(() => {
			const h = getHealth(engine, 'test-source');
			expect(h.consecutiveErrors).toBeGreaterThanOrEqual(1);
		});

		// 2 more manual failures (total: 3 with scheduler poll = under threshold of 4)
		// biome-ignore lint: accessing private for test
		await (engine as any).pollSource('test-source');
		// biome-ignore lint: accessing private for test
		await (engine as any).pollSource('test-source');

		let h = getHealth(engine, 'test-source');
		expect(h.circuitOpen).toBe(false);
		expect(h.status).toBe('degraded');

		// One more — reaches threshold of 4
		// biome-ignore lint: accessing private for test
		await (engine as any).pollSource('test-source');

		h = getHealth(engine, 'test-source');
		expect(h.circuitOpen).toBe(true);
		expect(h.status).toBe('unhealthy');

		await engine.stop();
	});

	it('skips polling when circuit is open', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');
		const pollSpy = vi.spyOn(source, 'poll').mockRejectedValue(new Error('error'));

		const engine = new OrgLoop(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
			circuitBreaker: { failureThreshold: 2 },
		});

		engine.on('error', () => {});

		await engine.start();

		// Open circuit (2 failures)
		// biome-ignore lint: accessing private for test
		await (engine as any).pollSource('test-source');
		// biome-ignore lint: accessing private for test
		await (engine as any).pollSource('test-source');

		expect(getHealth(engine, 'test-source').circuitOpen).toBe(true);

		const callCount = pollSpy.mock.calls.length;

		// Try polling again — should be skipped
		// biome-ignore lint: accessing private for test
		await (engine as any).pollSource('test-source');

		// poll() should NOT have been called again
		expect(pollSpy.mock.calls.length).toBe(callCount);

		await engine.stop();
	});

	it('retries after backoff period and recovers on success', async () => {
		vi.useFakeTimers();

		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');
		const pollSpy = vi.spyOn(source, 'poll');

		// First 2 polls fail
		pollSpy.mockRejectedValueOnce(new Error('error'));
		pollSpy.mockRejectedValueOnce(new Error('error'));
		// Recovery poll succeeds
		pollSpy.mockResolvedValueOnce({ events: [], checkpoint: 'ok' });

		const engine = new OrgLoop(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
			circuitBreaker: { failureThreshold: 2, retryAfterMs: 5000 },
		});

		engine.on('error', () => {});

		await engine.start();

		// Trigger 2 failures to open circuit
		// biome-ignore lint: accessing private for test
		await (engine as any).pollSource('test-source');
		// biome-ignore lint: accessing private for test
		await (engine as any).pollSource('test-source');

		expect(getHealth(engine, 'test-source').circuitOpen).toBe(true);

		// Advance past backoff
		await vi.advanceTimersByTimeAsync(5000);

		// After retry, circuit should be closed
		const h = getHealth(engine, 'test-source');
		expect(h.circuitOpen).toBe(false);
		expect(h.consecutiveErrors).toBe(0);
		expect(h.status).toBe('healthy');

		vi.useRealTimers();
		await engine.stop();
	});

	it('stays in circuit-open state if retry fails', async () => {
		vi.useFakeTimers();

		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		vi.spyOn(source, 'poll').mockRejectedValue(new Error('still broken'));

		const engine = new OrgLoop(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
			circuitBreaker: { failureThreshold: 2, retryAfterMs: 5000 },
		});

		engine.on('error', () => {});

		await engine.start();

		// Open circuit
		// biome-ignore lint: accessing private for test
		await (engine as any).pollSource('test-source');
		// biome-ignore lint: accessing private for test
		await (engine as any).pollSource('test-source');

		expect(getHealth(engine, 'test-source').circuitOpen).toBe(true);

		// Advance past backoff — retry will also fail
		await vi.advanceTimersByTimeAsync(5000);

		const h = getHealth(engine, 'test-source');
		expect(h.circuitOpen).toBe(true);
		expect(h.status).toBe('unhealthy');

		vi.useRealTimers();
		await engine.stop();
	});

	it('cleans up retry timers on stop', async () => {
		vi.useFakeTimers();

		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		vi.spyOn(source, 'poll').mockRejectedValue(new Error('error'));

		const engine = new OrgLoop(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
			circuitBreaker: { failureThreshold: 2, retryAfterMs: 60000 },
		});

		engine.on('error', () => {});

		await engine.start();

		// Open circuit
		// biome-ignore lint: accessing private for test
		await (engine as any).pollSource('test-source');
		// biome-ignore lint: accessing private for test
		await (engine as any).pollSource('test-source');

		// Stop engine — should clear timers without error
		await engine.stop();

		// Advancing time should not cause errors
		await vi.advanceTimersByTimeAsync(60000);

		vi.useRealTimers();
	});
});
