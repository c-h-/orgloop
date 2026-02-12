/**
 * Transform error policy tests — verifies on_error: pass | drop | halt behavior.
 */

import { MockActor, MockSource, createTestContext, createTestEvent } from '@orgloop/sdk';
import type {
	OrgLoopConfig,
	OrgLoopEvent,
	Transform,
	TransformContext,
	TransformDefinition,
} from '@orgloop/sdk';
import { describe, expect, it, vi } from 'vitest';
import { OrgLoop } from '../engine.js';
import { TransformError } from '../errors.js';
import { executeTransformPipeline } from '../transform.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

class FailingTransform implements Transform {
	async init(): Promise<void> {}
	async execute(_event: OrgLoopEvent, _ctx: TransformContext): Promise<OrgLoopEvent | null> {
		throw new Error('transform exploded');
	}
}

class PassthroughTransform implements Transform {
	async init(): Promise<void> {}
	async execute(event: OrgLoopEvent, _ctx: TransformContext): Promise<OrgLoopEvent | null> {
		return event;
	}
}

function makeDef(name: string, onError?: 'pass' | 'drop' | 'halt'): TransformDefinition {
	return {
		name,
		type: 'package',
		package: `@orgloop/transform-${name}`,
		on_error: onError,
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('transform error policy', () => {
	const event = createTestEvent();
	const ctx = createTestContext();

	it('pass (default): error is logged, event passes through unchanged', async () => {
		const onLog = vi.fn();
		const result = await executeTransformPipeline(event, ctx, [{ ref: 'boom' }], {
			definitions: [makeDef('boom')],
			packageTransforms: new Map([['boom', new FailingTransform()]]),
			onLog,
		});

		expect(result.dropped).toBe(false);
		expect(result.event).toEqual(event);

		// Should log transform.error (not error_drop or error_halt)
		const errorLog = onLog.mock.calls.find((call) => call[0]?.phase === 'transform.error');
		expect(errorLog).toBeDefined();
	});

	it('pass (explicit): same as default fail-open behavior', async () => {
		const onLog = vi.fn();
		const result = await executeTransformPipeline(event, ctx, [{ ref: 'boom' }], {
			definitions: [makeDef('boom', 'pass')],
			packageTransforms: new Map([['boom', new FailingTransform()]]),
			onLog,
		});

		expect(result.dropped).toBe(false);
		expect(result.event).toEqual(event);
	});

	it('drop: error causes event to be dropped', async () => {
		const onLog = vi.fn();
		const result = await executeTransformPipeline(event, ctx, [{ ref: 'boom' }], {
			definitions: [makeDef('boom', 'drop')],
			packageTransforms: new Map([['boom', new FailingTransform()]]),
			onLog,
		});

		expect(result.dropped).toBe(true);
		expect(result.event).toBeNull();
		expect(result.dropTransform).toBe('boom');
		expect(result.error).toBeDefined();

		// Should log transform.error_drop
		const errorLog = onLog.mock.calls.find((call) => call[0]?.phase === 'transform.error_drop');
		expect(errorLog).toBeDefined();
	});

	it('halt: error throws TransformError to halt the pipeline', async () => {
		const onLog = vi.fn();

		await expect(
			executeTransformPipeline(event, ctx, [{ ref: 'boom' }], {
				definitions: [makeDef('boom', 'halt')],
				packageTransforms: new Map([['boom', new FailingTransform()]]),
				onLog,
			}),
		).rejects.toThrow(TransformError);

		// Should log transform.error_halt
		const errorLog = onLog.mock.calls.find((call) => call[0]?.phase === 'transform.error_halt');
		expect(errorLog).toBeDefined();
	});

	it('drop: pipeline stops at failing transform, skips subsequent transforms', async () => {
		const secondTransform = vi.fn();
		const second: Transform = {
			init: async () => {},
			execute: async (e) => {
				secondTransform();
				return e;
			},
		};

		const result = await executeTransformPipeline(
			event,
			ctx,
			[{ ref: 'boom' }, { ref: 'second' }],
			{
				definitions: [makeDef('boom', 'drop'), makeDef('second')],
				packageTransforms: new Map<string, Transform>([
					['boom', new FailingTransform()],
					['second', second],
				]),
				onLog: vi.fn(),
			},
		);

		expect(result.dropped).toBe(true);
		expect(secondTransform).not.toHaveBeenCalled();
	});

	it('pass: pipeline continues to next transform after error', async () => {
		const result = await executeTransformPipeline(event, ctx, [{ ref: 'boom' }, { ref: 'ok' }], {
			definitions: [makeDef('boom', 'pass'), makeDef('ok')],
			packageTransforms: new Map<string, Transform>([
				['boom', new FailingTransform()],
				['ok', new PassthroughTransform()],
			]),
			onLog: vi.fn(),
		});

		expect(result.dropped).toBe(false);
		expect(result.event).toEqual(event);
	});

	it('succeeding transform does not trigger error policy', async () => {
		const onLog = vi.fn();
		const result = await executeTransformPipeline(event, ctx, [{ ref: 'ok' }], {
			definitions: [makeDef('ok', 'halt')],
			packageTransforms: new Map([['ok', new PassthroughTransform()]]),
			onLog,
		});

		expect(result.dropped).toBe(false);
		expect(result.event).toEqual(event);

		// Should log transform.pass, not any error phase
		const errorLogs = onLog.mock.calls.filter((call) =>
			call[0]?.phase?.startsWith('transform.error'),
		);
		expect(errorLogs).toHaveLength(0);
	});

	it('route-level on_error overrides definition-level on_error', async () => {
		const onLog = vi.fn();
		// Definition says 'pass', but route ref says 'drop'
		const result = await executeTransformPipeline(event, ctx, [{ ref: 'boom', on_error: 'drop' }], {
			definitions: [makeDef('boom', 'pass')],
			packageTransforms: new Map([['boom', new FailingTransform()]]),
			onLog,
		});

		// Route-level 'drop' should win over definition-level 'pass'
		expect(result.dropped).toBe(true);
		expect(result.event).toBeNull();
		expect(result.dropTransform).toBe('boom');

		const errorLog = onLog.mock.calls.find((call) => call[0]?.phase === 'transform.error_drop');
		expect(errorLog).toBeDefined();
	});
});

// ─── Engine Integration Tests ─────────────────────────────────────────────────

function makeEngineConfig(overrides?: Partial<OrgLoopConfig>): OrgLoopConfig {
	return {
		project: { name: 'test-error-policy' },
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
				when: { source: 'test-source', events: ['resource.changed'] },
				transforms: [{ ref: 'boom' }],
				then: { actor: 'test-actor' },
			},
		],
		transforms: [{ name: 'boom', type: 'package', package: '@orgloop/transform-boom' }],
		loggers: [],
		...overrides,
	};
}

describe('transform error policy — engine integration', () => {
	it('pass: event is delivered despite transform error', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const config = makeEngineConfig({
			transforms: [
				{
					name: 'boom',
					type: 'package',
					package: '@orgloop/transform-boom',
					on_error: 'pass',
				},
			],
		});

		const engine = new OrgLoop(config, {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
			transforms: new Map([['boom', new FailingTransform()]]),
		});

		await engine.start();

		const event = createTestEvent({
			source: 'test-source',
			type: 'resource.changed',
		});
		await engine.inject(event);

		// pass policy: event should still be delivered
		expect(actor.delivered).toHaveLength(1);

		await engine.stop();
	});

	it('drop: event is not delivered when transform errors with drop policy', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const config = makeEngineConfig({
			transforms: [
				{
					name: 'boom',
					type: 'package',
					package: '@orgloop/transform-boom',
					on_error: 'drop',
				},
			],
		});

		const engine = new OrgLoop(config, {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
			transforms: new Map([['boom', new FailingTransform()]]),
		});

		await engine.start();

		const event = createTestEvent({
			source: 'test-source',
			type: 'resource.changed',
		});
		await engine.inject(event);

		// drop policy: event should NOT be delivered
		expect(actor.delivered).toHaveLength(0);

		await engine.stop();
	});

	it('halt: event is not delivered and engine emits error', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const config = makeEngineConfig({
			transforms: [
				{
					name: 'boom',
					type: 'package',
					package: '@orgloop/transform-boom',
					on_error: 'halt',
				},
			],
		});

		const engine = new OrgLoop(config, {
			sources: new Map([['test-source', source]]),
			actors: new Map([['test-actor', actor]]),
			transforms: new Map([['boom', new FailingTransform()]]),
		});

		await engine.start();

		const errors: Error[] = [];
		engine.on('error', (err: Error) => errors.push(err));

		const event = createTestEvent({
			source: 'test-source',
			type: 'resource.changed',
		});
		await engine.inject(event);

		// halt policy: event should NOT be delivered
		expect(actor.delivered).toHaveLength(0);

		// Engine should have emitted a TransformError
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(TransformError);

		await engine.stop();
	});
});
