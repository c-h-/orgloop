/**
 * RouteDispatcher unit tests — exercises the 8 dispatch paths from the
 * P2 spec without constructing a full Runtime. Constructs the dispatcher
 * with hand-rolled fakes for every collaborator, verifying the
 * interface boundary set by `RouteDispatcherDeps`.
 */

import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	ActorConnector,
	OrgLoopEvent,
	RouteDefinition,
	RouteDeliveryConfig,
} from '@orgloop/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '../audit.js';
import { contentHash } from '../audit.js';
import { DeliveryError } from '../errors.js';
import { RouteDispatcher } from '../route-dispatcher.js';

interface ActorDeliverResult {
	status: 'delivered' | 'rejected' | 'error';
	error?: { message: string };
}

interface FakeContext {
	dispatcher: RouteDispatcher;
	actor: {
		deliver: ReturnType<typeof vi.fn>;
		init: ReturnType<typeof vi.fn>;
		shutdown: ReturnType<typeof vi.fn>;
	};
	mod: {
		name: string;
		getActor: ReturnType<typeof vi.fn>;
	};
	auditTrail: { record: ReturnType<typeof vi.fn>; records: AuditRecord[] };
	emit: ReturnType<typeof vi.fn>;
	loggerManager: { log: ReturnType<typeof vi.fn> };
	outputValidator: { validate: ReturnType<typeof vi.fn> };
	loopDetector: {
		check: ReturnType<typeof vi.fn>;
		getChainDepth: ReturnType<typeof vi.fn>;
	};
	inboxManager: { enqueue: ReturnType<typeof vi.fn> } | null;
}

interface FakeOptions {
	deliverResult?: ActorDeliverResult;
	deliverThrows?: Error;
	validation?: { passed?: boolean; flags: unknown[]; hold_for_review: boolean };
	withInbox?: boolean;
	inboxThrows?: Error;
	withoutActor?: boolean;
}

function makeEvent(overrides: Partial<OrgLoopEvent> = {}): OrgLoopEvent {
	return {
		id: 'evt_test',
		timestamp: new Date().toISOString(),
		source: 'src',
		type: 'actor.stopped',
		provenance: { platform: 'test', author: 'tester', author_type: 'bot' },
		payload: { foo: 'bar' },
		trace_id: 'trc_test',
		...overrides,
	} as OrgLoopEvent;
}

function makeRoute(overrides: Partial<RouteDefinition> = {}): RouteDefinition {
	return {
		name: 'test-route',
		when: { source: 'src', events: ['actor.stopped'] },
		then: { actor: 'test-actor' },
		...overrides,
	} as RouteDefinition;
}

function setupContext(options: FakeOptions = {}): FakeContext {
	const records: AuditRecord[] = [];
	const auditTrail = {
		record: vi.fn((r: AuditRecord) => {
			records.push(r);
		}),
	};

	const actor = {
		init: vi.fn(),
		shutdown: vi.fn(),
		deliver: vi.fn(async (_event: OrgLoopEvent, _config: RouteDeliveryConfig) => {
			if (options.deliverThrows) throw options.deliverThrows;
			return options.deliverResult ?? { status: 'delivered' };
		}),
	};

	const mod = {
		name: 'test-module',
		getActor: vi.fn(() =>
			options.withoutActor ? undefined : (actor as unknown as ActorConnector),
		),
	};

	const validation = options.validation ?? { passed: true, flags: [], hold_for_review: false };
	const outputValidator = {
		validate: vi.fn(() => validation),
	};

	const loopDetector = {
		check: vi.fn(() => ({
			chain_depth: 1,
			loop_detected: false,
			circuit_broken: false,
			chain: [],
			flags: [],
		})),
		getChainDepth: vi.fn(() => 1),
	};

	const inboxManager = options.withInbox
		? {
				enqueue: vi.fn(async () => {
					if (options.inboxThrows) throw options.inboxThrows;
				}),
			}
		: null;

	const loggerManager = { log: vi.fn(async () => {}) };
	const emit = vi.fn();

	const dispatcher = new RouteDispatcher({
		loggerManager: loggerManager as never,
		metricsServer: null,
		inboxManager: inboxManager as never,
		loopDetector: loopDetector as never,
		outputValidator: outputValidator as never,
		auditTrail: auditTrail as never,
		emit,
	});

	return {
		dispatcher,
		actor,
		mod,
		auditTrail: { ...auditTrail, records },
		emit,
		loggerManager,
		outputValidator,
		loopDetector,
		inboxManager,
	};
}

describe('RouteDispatcher.dispatch — status states', () => {
	it('returns status=delivered when actor.deliver succeeds', async () => {
		const ctx = setupContext({ deliverResult: { status: 'delivered' } });
		const result = await ctx.dispatcher.dispatch(makeEvent(), makeRoute(), ctx.mod as never);
		expect(result.status).toBe('delivered');
		expect(ctx.auditTrail.records[0].delivery_status).toBe('delivered');
		expect(ctx.actor.deliver).toHaveBeenCalledTimes(1);
	});

	it('returns status=rejected when actor.deliver returns rejected', async () => {
		const ctx = setupContext({ deliverResult: { status: 'rejected' } });
		const result = await ctx.dispatcher.dispatch(makeEvent(), makeRoute(), ctx.mod as never);
		expect(result.status).toBe('rejected');
		expect(ctx.auditTrail.records[0].delivery_status).toBe('rejected');
		expect(ctx.actor.deliver).toHaveBeenCalledTimes(1);
	});

	it('returns status=error when actor.deliver throws', async () => {
		const ctx = setupContext({ deliverThrows: new Error('boom') });
		const result = await ctx.dispatcher.dispatch(makeEvent(), makeRoute(), ctx.mod as never);
		expect(result.status).toBe('error');
		expect(ctx.auditTrail.records[0].delivery_status).toBe('error');
		const errorEmits = ctx.emit.mock.calls.filter((c) => c[0] === 'error');
		expect(errorEmits.length).toBeGreaterThan(0);
		expect(errorEmits[0][1]).toBeInstanceOf(DeliveryError);
	});

	it('returns status=error when actor is missing', async () => {
		const ctx = setupContext({ withoutActor: true });
		const result = await ctx.dispatcher.dispatch(makeEvent(), makeRoute(), ctx.mod as never);
		expect(result.status).toBe('error');
		expect(ctx.auditTrail.records[0].delivery_status).toBe('error');
	});
});

describe('RouteDispatcher.dispatch — held paths', () => {
	it('returns status=held (validator) when output-validator hold_for_review is true', async () => {
		const ctx = setupContext({
			validation: {
				flags: [
					{
						type: 'instruction_content',
						severity: 'critical',
						message: 'critical flag',
					},
				],
				hold_for_review: true,
				passed: false,
			},
		});
		const result = await ctx.dispatcher.dispatch(makeEvent(), makeRoute(), ctx.mod as never);
		expect(result.status).toBe('held');
		expect(ctx.auditTrail.records[0].delivery_status).toBe('held');
		expect(ctx.auditTrail.records[0].held_for_review).toBe(true);
		expect(ctx.actor.deliver).not.toHaveBeenCalled();
	});

	it('returns status=held (inbox) and emits delivery with status=held + inbox:true', async () => {
		const ctx = setupContext({ withInbox: true });
		const route = makeRoute({
			then: {
				actor: 'test-actor',
				config: { inbox: true, session_key: 'sess-1' },
			},
		});
		const result = await ctx.dispatcher.dispatch(makeEvent(), route, ctx.mod as never);
		expect(result.status).toBe('held');
		// All three writers must agree:
		expect(ctx.auditTrail.records[0].delivery_status).toBe('held');
		const deliveryEmits = ctx.emit.mock.calls.filter((c) => c[0] === 'delivery');
		expect(deliveryEmits.length).toBe(1);
		expect(deliveryEmits[0][1]).toMatchObject({ status: 'held', inbox: true });
		expect(ctx.actor.deliver).not.toHaveBeenCalled();
	});
});

describe('RouteDispatcher.dispatch — prompt_file resolution', () => {
	it('reads prompt_file content and includes it in delivery config', async () => {
		const path = join(tmpdir(), `orgloop-test-prompt-${Date.now()}.md`);
		await writeFile(path, '---\nkey: value\n---\nbody-text', 'utf-8');
		const ctx = setupContext({ deliverResult: { status: 'delivered' } });
		const route = makeRoute({ with: { prompt_file: path } });

		await ctx.dispatcher.dispatch(makeEvent(), route, ctx.mod as never);

		const [, deliveryConfig] = ctx.actor.deliver.mock.calls[0];
		expect(deliveryConfig.launch_prompt).toBe('body-text');
		expect(deliveryConfig.launch_prompt_file).toBe(path);
		expect(deliveryConfig.launch_prompt_meta).toMatchObject({ key: 'value' });
	});

	it('continues delivery when prompt_file is missing (non-fatal)', async () => {
		const ctx = setupContext({ deliverResult: { status: 'delivered' } });
		const route = makeRoute({ with: { prompt_file: '/nonexistent/path-does-not-exist.md' } });

		const result = await ctx.dispatcher.dispatch(makeEvent(), route, ctx.mod as never);

		expect(result.status).toBe('delivered');
		const [, deliveryConfig] = ctx.actor.deliver.mock.calls[0];
		expect(deliveryConfig.launch_prompt).toBeUndefined();
	});
});

describe('RouteDispatcher.dispatch — audit content_hash', () => {
	it('writes input_content_hash from event.payload and output content_hash from delivery config', async () => {
		const event = makeEvent({ payload: { abc: 1 } });
		const ctx = setupContext({ deliverResult: { status: 'delivered' } });
		await ctx.dispatcher.dispatch(event, makeRoute(), ctx.mod as never);

		const record = ctx.auditTrail.records[0];
		expect(record.input_content_hash).toBe(contentHash(event.payload));
		expect(record.outputs.length).toBeGreaterThan(0);
		// The dispatched delivery config is { } when no route.then.config
		expect(record.outputs[0].content_hash).toBe(contentHash({}));
	});
});
