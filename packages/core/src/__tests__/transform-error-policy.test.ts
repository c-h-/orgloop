/**
 * Transform error policy tests — verifies on_error: pass | drop | halt behavior.
 */

import { createTestContext, createTestEvent } from '@orgloop/sdk';
import type { OrgLoopEvent, Transform, TransformContext, TransformDefinition } from '@orgloop/sdk';
import { describe, expect, it, vi } from 'vitest';
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
});
