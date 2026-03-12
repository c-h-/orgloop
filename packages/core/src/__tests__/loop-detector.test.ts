import { createTestEvent } from '@orgloop/sdk';
import { describe, expect, it } from 'vitest';
import { LoopDetector } from '../loop-detector.js';
import { Runtime } from '../runtime.js';

// ─── Unit Tests: LoopDetector ────────────────────────────────────────────────

describe('LoopDetector', () => {
	it('tracks chain depth for events with the same trace_id', () => {
		const detector = new LoopDetector();

		const r1 = detector.check('trc_1', 'evt_1', 'src-a', 'resource.changed', 'route-a', 'actor-a');
		expect(r1.chain_depth).toBe(1);
		expect(r1.loop_detected).toBe(false);
		expect(r1.circuit_broken).toBe(false);

		const r2 = detector.check('trc_1', 'evt_2', 'src-b', 'actor.stopped', 'route-b', 'actor-b');
		expect(r2.chain_depth).toBe(2);
		expect(r2.loop_detected).toBe(false);

		const r3 = detector.check('trc_1', 'evt_3', 'src-c', 'resource.changed', 'route-c', 'actor-c');
		expect(r3.chain_depth).toBe(3);
	});

	it('detects loops when chain exceeds maxChainDepth', () => {
		const detector = new LoopDetector({ maxChainDepth: 2 });

		detector.check('trc_1', 'evt_1', 'src-a', 'resource.changed', null, null);
		detector.check('trc_1', 'evt_2', 'src-b', 'actor.stopped', null, null);
		const r3 = detector.check('trc_1', 'evt_3', 'src-c', 'resource.changed', null, null);

		expect(r3.loop_detected).toBe(true);
		expect(r3.chain_depth).toBe(3);
		expect(r3.flags.some((f) => f.type === 'chain_depth')).toBe(true);
	});

	it('detects pattern loops (repeated source+type)', () => {
		const detector = new LoopDetector({ maxChainDepth: 10 });

		detector.check('trc_1', 'evt_1', 'github', 'resource.changed', null, null);
		const r2 = detector.check('trc_1', 'evt_2', 'github', 'resource.changed', null, null);

		expect(r2.loop_detected).toBe(true);
		expect(r2.flags.some((f) => f.message.includes('Repeated event pattern'))).toBe(true);
	});

	it('circuit breaks at circuitBreakerDepth', () => {
		const detector = new LoopDetector({ maxChainDepth: 2, circuitBreakerDepth: 4 });

		detector.check('trc_1', 'evt_1', 'src', 'resource.changed', null, null);
		detector.check('trc_1', 'evt_2', 'src', 'actor.stopped', null, null);
		detector.check('trc_1', 'evt_3', 'src', 'resource.changed', null, null);
		const r4 = detector.check('trc_1', 'evt_4', 'src', 'actor.stopped', null, null);

		expect(r4.circuit_broken).toBe(true);
		expect(detector.isCircuitBroken('trc_1')).toBe(true);
	});

	it('blocks all subsequent events after circuit break', () => {
		const detector = new LoopDetector({ maxChainDepth: 2, circuitBreakerDepth: 3 });

		detector.check('trc_1', 'evt_1', 'src', 'resource.changed', null, null);
		detector.check('trc_1', 'evt_2', 'src', 'actor.stopped', null, null);
		detector.check('trc_1', 'evt_3', 'src', 'resource.changed', null, null); // breaks

		const r4 = detector.check('trc_1', 'evt_4', 'src', 'actor.stopped', null, null);
		expect(r4.circuit_broken).toBe(true);
		expect(r4.loop_detected).toBe(true);
	});

	it('allows manual circuit reset', () => {
		const detector = new LoopDetector({ maxChainDepth: 1, circuitBreakerDepth: 2 });

		detector.check('trc_1', 'evt_1', 'src', 'resource.changed', null, null);
		detector.check('trc_1', 'evt_2', 'src', 'actor.stopped', null, null); // breaks

		expect(detector.isCircuitBroken('trc_1')).toBe(true);

		detector.resetCircuit('trc_1');
		expect(detector.isCircuitBroken('trc_1')).toBe(false);
	});

	it('tracks separate chains for different trace_ids', () => {
		const detector = new LoopDetector({ maxChainDepth: 2 });

		detector.check('trc_a', 'evt_1', 'src', 'resource.changed', null, null);
		detector.check('trc_b', 'evt_2', 'src', 'resource.changed', null, null);

		expect(detector.getChainDepth('trc_a')).toBe(1);
		expect(detector.getChainDepth('trc_b')).toBe(1);
		expect(detector.activeTraces()).toBe(2);
	});

	it('getChain returns full chain for a trace', () => {
		const detector = new LoopDetector();

		detector.check('trc_1', 'evt_1', 'src-a', 'resource.changed', 'route-1', 'actor-1');
		detector.check('trc_1', 'evt_2', 'src-b', 'actor.stopped', 'route-2', 'actor-2');

		const chain = detector.getChain('trc_1');
		expect(chain).toHaveLength(2);
		expect(chain[0].event_id).toBe('evt_1');
		expect(chain[0].depth).toBe(1);
		expect(chain[1].event_id).toBe('evt_2');
		expect(chain[1].depth).toBe(2);
	});

	it('returns empty chain for unknown trace', () => {
		const detector = new LoopDetector();
		expect(detector.getChain('unknown')).toHaveLength(0);
		expect(detector.getChainDepth('unknown')).toBe(0);
	});

	it('reports brokenCircuitCount', () => {
		const detector = new LoopDetector({ maxChainDepth: 1, circuitBreakerDepth: 2 });

		detector.check('trc_a', 'evt_1', 'src', 'resource.changed', null, null);
		detector.check('trc_a', 'evt_2', 'src', 'actor.stopped', null, null);

		detector.check('trc_b', 'evt_3', 'src', 'resource.changed', null, null);
		detector.check('trc_b', 'evt_4', 'src', 'actor.stopped', null, null);

		expect(detector.brokenCircuitCount()).toBe(2);
	});

	it('cleans up expired traces', () => {
		const detector = new LoopDetector({ windowMs: 1 }); // 1ms window

		detector.check('trc_old', 'evt_1', 'src', 'resource.changed', null, null);

		// Wait for expiry
		const start = Date.now();
		while (Date.now() - start < 5) {
			// busy wait 5ms
		}

		// New check triggers cleanup
		detector.check('trc_new', 'evt_2', 'src', 'resource.changed', null, null);

		expect(detector.getChainDepth('trc_old')).toBe(0);
		expect(detector.activeTraces()).toBe(1);
	});
});

// ─── Integration Tests: Loop Detection in Runtime ────────────────────────────

describe('Loop detection integration', () => {
	it('circuit-breaks event chains exceeding depth limit', async () => {
		const runtime = new Runtime({
			loopDetector: { maxChainDepth: 2, circuitBreakerDepth: 3 },
		});

		const { MockSource, MockActor } = await import('@orgloop/sdk');
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		await runtime.start();
		await runtime.loadModule(
			{
				name: 'default',
				sources: [{ id: 'test-source', connector: 'mock', config: {}, poll: { interval: '5m' } }],
				actors: [{ id: 'test-actor', connector: 'mock', config: {} }],
				routes: [
					{
						name: 'test-route',
						when: { source: 'test-source', events: ['resource.changed'] },
						then: { actor: 'test-actor' },
					},
				],
				transforms: [],
				loggers: [],
			},
			{
				sources: new Map([['test-source', source]]),
				actors: new Map([['test-actor', actor]]),
			},
		);

		const traceId = 'trc_loop_test';

		// Inject 5 events with same trace_id (simulating a chain)
		for (let i = 0; i < 5; i++) {
			const event = createTestEvent({
				source: 'test-source',
				type: 'resource.changed',
				trace_id: traceId,
			});
			await runtime.inject(event);
		}

		// First 3 should be delivered (depth 1, 2, 3 where 3 triggers circuit break)
		// Events 4 and 5 should be blocked
		// Circuit breaks at depth 3, so events at depth 3+ are blocked
		// Actually: depth 1 and 2 are processed. Depth 3 triggers circuit break.
		// So only 2 events get delivered.
		expect(actor.delivered.length).toBeLessThan(5);
		expect(runtime.getLoopDetector().isCircuitBroken(traceId)).toBe(true);

		await runtime.stop();
	});

	it('allows events with different trace_ids independently', async () => {
		const runtime = new Runtime({
			loopDetector: { maxChainDepth: 2, circuitBreakerDepth: 3 },
		});

		const { MockSource, MockActor } = await import('@orgloop/sdk');
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		await runtime.start();
		await runtime.loadModule(
			{
				name: 'default',
				sources: [{ id: 'test-source', connector: 'mock', config: {}, poll: { interval: '5m' } }],
				actors: [{ id: 'test-actor', connector: 'mock', config: {} }],
				routes: [
					{
						name: 'test-route',
						when: { source: 'test-source', events: ['resource.changed'] },
						then: { actor: 'test-actor' },
					},
				],
				transforms: [],
				loggers: [],
			},
			{
				sources: new Map([['test-source', source]]),
				actors: new Map([['test-actor', actor]]),
			},
		);

		// Each event with a different trace_id should be delivered independently
		for (let i = 0; i < 3; i++) {
			const event = createTestEvent({
				source: 'test-source',
				type: 'resource.changed',
				trace_id: `trc_independent_${i}`,
			});
			await runtime.inject(event);
		}

		expect(actor.delivered).toHaveLength(3);

		await runtime.stop();
	});

	it('emits loop:detected event when chain exceeds threshold', async () => {
		const runtime = new Runtime({
			loopDetector: { maxChainDepth: 1, circuitBreakerDepth: 10 },
		});

		const { MockSource, MockActor } = await import('@orgloop/sdk');
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		await runtime.start();
		await runtime.loadModule(
			{
				name: 'default',
				sources: [{ id: 'test-source', connector: 'mock', config: {}, poll: { interval: '5m' } }],
				actors: [{ id: 'test-actor', connector: 'mock', config: {} }],
				routes: [
					{
						name: 'test-route',
						when: { source: 'test-source', events: ['resource.changed'] },
						then: { actor: 'test-actor' },
					},
				],
				transforms: [],
				loggers: [],
			},
			{
				sources: new Map([['test-source', source]]),
				actors: new Map([['test-actor', actor]]),
			},
		);

		const detected: unknown[] = [];
		runtime.on('loop:detected', (data) => detected.push(data));

		const traceId = 'trc_detect_test';
		for (let i = 0; i < 3; i++) {
			const event = createTestEvent({
				source: 'test-source',
				type: 'resource.changed',
				trace_id: traceId,
			});
			await runtime.inject(event);
		}

		// Events at depth 2 and 3 should trigger loop:detected
		expect(detected.length).toBeGreaterThan(0);

		await runtime.stop();
	});
});
