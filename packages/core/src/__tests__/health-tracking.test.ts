import type { OrgLoopConfig, SourceHealthState } from '@orgloop/sdk';
import { createTestEvent, MockActor, MockSource } from '@orgloop/sdk';
import { describe, expect, it, vi } from 'vitest';
import { Runtime } from '../runtime.js';

function getHealth(runtime: Runtime, sourceId: string): SourceHealthState {
	const status = runtime.status();
	for (const mod of status.modules) {
		const h = mod.health?.find((s) => s.sourceId === sourceId);
		if (h) return h;
	}
	throw new Error(`No health state for ${sourceId}`);
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

function makeRuntime(
	config: OrgLoopConfig,
	loadOptions: import('../runtime.js').LoadModuleOptions,
	runtimeOptions?: import('../runtime.js').RuntimeOptions,
): Runtime {
	return Runtime.singleModule(config, {
		load: loadOptions,
		runtime: { crashHandlers: false, ...(runtimeOptions ?? {}) },
	});
}

describe('Source health tracking', () => {
	it('initializes health state for all sources on start', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const runtime = makeRuntime(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
		});

		await runtime.start();

		const h = getHealth(runtime, 'test-source');
		expect(h.sourceId).toBe('test-source');
		expect(h.status).toBe('healthy');
		expect(h.consecutiveErrors).toBe(0);
		expect(h.circuitOpen).toBe(false);
		expect(h.totalEventsEmitted).toBe(0);

		await runtime.stop();
	});

	it('tracks successful polls and event counts', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const runtime = makeRuntime(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
		});

		await runtime.start();

		const event1 = createTestEvent({ source: 'test-source', type: 'resource.changed' });
		const event2 = createTestEvent({ source: 'test-source', type: 'resource.changed' });
		source.addEvents(event1, event2);

		await runtime.pollSource('test-source');

		const h = getHealth(runtime, 'test-source');
		expect(h.status).toBe('healthy');
		expect(h.totalEventsEmitted).toBe(2);
		expect(h.lastSuccessfulPoll).not.toBeNull();
		expect(h.consecutiveErrors).toBe(0);
		expect(h.lastError).toBeNull();

		await runtime.stop();
	});

	it('tracks consecutive errors on poll failure', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		vi.spyOn(source, 'poll').mockRejectedValue(new Error('403 Forbidden'));

		const runtime = makeRuntime(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
		});

		runtime.on('error', () => {});

		await runtime.start();
		await vi.waitFor(() => {
			const h = getHealth(runtime, 'test-source');
			expect(h.consecutiveErrors).toBeGreaterThanOrEqual(1);
		});

		let h = getHealth(runtime, 'test-source');
		const errorsAfterStart = h.consecutiveErrors;
		expect(h.status).toBe('degraded');
		expect(h.lastError).toBe('403 Forbidden');

		await runtime.pollSource('test-source');

		h = getHealth(runtime, 'test-source');
		expect(h.consecutiveErrors).toBe(errorsAfterStart + 1);

		await runtime.stop();
	});

	it('resets error count on successful poll after failures', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');
		const pollSpy = vi.spyOn(source, 'poll');

		pollSpy.mockRejectedValueOnce(new Error('network error'));
		pollSpy.mockRejectedValueOnce(new Error('network error'));

		const runtime = makeRuntime(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
		});

		runtime.on('error', () => {});

		await runtime.start();
		await vi.waitFor(() => {
			const h = getHealth(runtime, 'test-source');
			expect(h.consecutiveErrors).toBeGreaterThanOrEqual(1);
		});

		await runtime.pollSource('test-source');

		let h = getHealth(runtime, 'test-source');
		expect(h.consecutiveErrors).toBeGreaterThanOrEqual(2);
		expect(h.status).toBe('degraded');

		pollSpy.mockRestore();

		await runtime.pollSource('test-source');

		h = getHealth(runtime, 'test-source');
		expect(h.consecutiveErrors).toBe(0);
		expect(h.status).toBe('healthy');
		expect(h.lastError).toBeNull();
		expect(h.lastSuccessfulPoll).not.toBeNull();

		await runtime.stop();
	});

	it('health data is included in runtime status', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const runtime = makeRuntime(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
		});

		await runtime.start();

		const status = runtime.status();
		expect(status.modules).toHaveLength(1);
		expect(status.modules[0].health).toBeDefined();
		expect(status.modules[0].health).toHaveLength(1);
		expect(status.modules[0].health?.[0].sourceId).toBe('test-source');

		await runtime.stop();
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

		const runtime = makeRuntime(config, {
			sources: new Map([
				['source-1', source1],
				['source-2', source2],
			]),
			actors: new Map([['test-actor', actor]]),
		});

		runtime.on('error', () => {});

		await runtime.start();
		await vi.waitFor(() => {
			const h1 = getHealth(runtime, 'source-1');
			expect(h1.consecutiveErrors).toBeGreaterThanOrEqual(1);
		});

		const h1 = getHealth(runtime, 'source-1');
		const h2 = getHealth(runtime, 'source-2');

		expect(h1.status).toBe('degraded');
		expect(h1.consecutiveErrors).toBeGreaterThanOrEqual(1);
		expect(h2.status).toBe('healthy');
		expect(h2.consecutiveErrors).toBe(0);

		await runtime.stop();
	});
});

describe('Circuit breaker', () => {
	it('opens circuit after N consecutive failures (default: 5)', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		vi.spyOn(source, 'poll').mockRejectedValue(new Error('403 Forbidden'));

		const runtime = makeRuntime(makeConfig(), {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
		});

		runtime.on('error', () => {});

		await runtime.start();

		for (let i = 0; i < 5; i++) {
			await runtime.pollSource('test-source');
		}

		const h = getHealth(runtime, 'test-source');
		expect(h.status).toBe('unhealthy');
		expect(h.circuitOpen).toBe(true);
		expect(h.consecutiveErrors).toBe(5);

		await runtime.stop();
	});

	it('respects custom failure threshold', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		vi.spyOn(source, 'poll').mockRejectedValue(new Error('timeout'));

		const runtime = makeRuntime(
			makeConfig(),
			{
				sources: new Map([['test-source', source]]),
				actors: new Map([['test-actor', actor]]),
			},
			{ circuitBreaker: { failureThreshold: 4 } },
		);

		runtime.on('error', () => {});

		await runtime.start();
		await vi.waitFor(() => {
			const h = getHealth(runtime, 'test-source');
			expect(h.consecutiveErrors).toBeGreaterThanOrEqual(1);
		});

		await runtime.pollSource('test-source');
		await runtime.pollSource('test-source');

		let h = getHealth(runtime, 'test-source');
		expect(h.circuitOpen).toBe(false);
		expect(h.status).toBe('degraded');

		await runtime.pollSource('test-source');

		h = getHealth(runtime, 'test-source');
		expect(h.circuitOpen).toBe(true);
		expect(h.status).toBe('unhealthy');

		await runtime.stop();
	});

	it('skips polling when circuit is open', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');
		const pollSpy = vi.spyOn(source, 'poll').mockRejectedValue(new Error('error'));

		const runtime = makeRuntime(
			makeConfig(),
			{
				sources: new Map([['test-source', source]]),
				actors: new Map([['test-actor', actor]]),
			},
			{ circuitBreaker: { failureThreshold: 2 } },
		);

		runtime.on('error', () => {});

		await runtime.start();

		await runtime.pollSource('test-source');
		await runtime.pollSource('test-source');

		expect(getHealth(runtime, 'test-source').circuitOpen).toBe(true);

		const callCount = pollSpy.mock.calls.length;

		await runtime.pollSource('test-source');

		expect(pollSpy.mock.calls.length).toBe(callCount);

		await runtime.stop();
	});

	it('retries after backoff period and recovers on success', async () => {
		vi.useFakeTimers();

		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');
		const pollSpy = vi.spyOn(source, 'poll');

		pollSpy.mockRejectedValueOnce(new Error('error'));
		pollSpy.mockRejectedValueOnce(new Error('error'));
		pollSpy.mockResolvedValueOnce({ events: [], checkpoint: 'ok' });

		const runtime = makeRuntime(
			makeConfig(),
			{
				sources: new Map([['test-source', source]]),
				actors: new Map([['test-actor', actor]]),
			},
			{ circuitBreaker: { failureThreshold: 2, retryAfterMs: 5000 } },
		);

		runtime.on('error', () => {});

		await runtime.start();

		await runtime.pollSource('test-source');
		await runtime.pollSource('test-source');

		expect(getHealth(runtime, 'test-source').circuitOpen).toBe(true);

		await vi.advanceTimersByTimeAsync(5000);

		const h = getHealth(runtime, 'test-source');
		expect(h.circuitOpen).toBe(false);
		expect(h.consecutiveErrors).toBe(0);
		expect(h.status).toBe('healthy');

		vi.useRealTimers();
		await runtime.stop();
	});

	it('stays in circuit-open state if retry fails', async () => {
		vi.useFakeTimers();

		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		vi.spyOn(source, 'poll').mockRejectedValue(new Error('still broken'));

		const runtime = makeRuntime(
			makeConfig(),
			{
				sources: new Map([['test-source', source]]),
				actors: new Map([['test-actor', actor]]),
			},
			{ circuitBreaker: { failureThreshold: 2, retryAfterMs: 5000 } },
		);

		runtime.on('error', () => {});

		await runtime.start();

		await runtime.pollSource('test-source');
		await runtime.pollSource('test-source');

		expect(getHealth(runtime, 'test-source').circuitOpen).toBe(true);

		await vi.advanceTimersByTimeAsync(5000);

		const h = getHealth(runtime, 'test-source');
		expect(h.circuitOpen).toBe(true);
		expect(h.status).toBe('unhealthy');

		vi.useRealTimers();
		await runtime.stop();
	});

	it('cleans up retry timers on stop', async () => {
		vi.useFakeTimers();

		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		vi.spyOn(source, 'poll').mockRejectedValue(new Error('error'));

		const runtime = makeRuntime(
			makeConfig(),
			{
				sources: new Map([['test-source', source]]),
				actors: new Map([['test-actor', actor]]),
			},
			{ circuitBreaker: { failureThreshold: 2, retryAfterMs: 60000 } },
		);

		runtime.on('error', () => {});

		await runtime.start();

		await runtime.pollSource('test-source');
		await runtime.pollSource('test-source');

		await runtime.stop();

		await vi.advanceTimersByTimeAsync(60000);

		vi.useRealTimers();
	});
});
