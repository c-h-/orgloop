import { describe, expect, it } from 'vitest';
import {
	createTestContext,
	createTestEvent,
	MockActor,
	MockLogger,
	MockSource,
	MockTransform,
} from '../testing.js';

describe('MockSource', () => {
	it('initializes and tracks state', async () => {
		const source = new MockSource('test');
		expect(source.initialized).toBe(false);
		await source.init({ id: 'test', connector: 'test', config: {} });
		expect(source.initialized).toBe(true);
	});

	it('returns added events on poll', async () => {
		const source = new MockSource('test');
		const event = createTestEvent();
		source.addEvents(event);

		const result = await source.poll(null);
		expect(result.events).toHaveLength(1);
		expect(result.events[0]).toBe(event);
		expect(result.checkpoint).toMatch(/^mock-checkpoint-/);
	});

	it('returns empty after events are consumed', async () => {
		const source = new MockSource('test');
		source.addEvents(createTestEvent());

		await source.poll(null);
		const result = await source.poll('checkpoint');
		expect(result.events).toHaveLength(0);
	});

	it('tracks shutdown', async () => {
		const source = new MockSource();
		expect(source.shutdownCalled).toBe(false);
		await source.shutdown();
		expect(source.shutdownCalled).toBe(true);
	});
});

describe('MockActor', () => {
	it('records delivered events', async () => {
		const actor = new MockActor('test');
		await actor.init({ id: 'test', connector: 'test', config: {} });

		const event = createTestEvent();
		const result = await actor.deliver(event, {});

		expect(result.status).toBe('delivered');
		expect(actor.delivered).toHaveLength(1);
		expect(actor.delivered[0].event).toBe(event);
	});

	it('can be set to reject', async () => {
		const actor = new MockActor();
		actor.setReject(true);

		const result = await actor.deliver(createTestEvent(), {});
		expect(result.status).toBe('rejected');
	});

	it('can be set to error', async () => {
		const actor = new MockActor();
		actor.setError(true);

		const result = await actor.deliver(createTestEvent(), {});
		expect(result.status).toBe('error');
		expect(result.error).toBeInstanceOf(Error);
	});
});

describe('MockTransform', () => {
	it('passes events by default', async () => {
		const transform = new MockTransform('test');
		const event = createTestEvent();
		const ctx = createTestContext();

		const result = await transform.execute(event, ctx);
		expect(result).toBe(event);
		expect(transform.processed).toHaveLength(1);
	});

	it('can drop events', async () => {
		const transform = new MockTransform();
		transform.setDrop(true);

		const result = await transform.execute(createTestEvent(), createTestContext());
		expect(result).toBeNull();
	});

	it('can modify events', async () => {
		const transform = new MockTransform();
		transform.setModifier((e) => ({ ...e, source: 'modified' }));

		const result = await transform.execute(createTestEvent(), createTestContext());
		expect(result?.source).toBe('modified');
	});
});

describe('MockLogger', () => {
	it('records log entries', async () => {
		const logger = new MockLogger('test');
		const entry = {
			timestamp: new Date().toISOString(),
			event_id: 'evt_test',
			trace_id: 'trc_test',
			phase: 'source.emit' as const,
			source: 'test',
		};

		await logger.log(entry);
		expect(logger.entries).toHaveLength(1);
	});

	it('filters entries by phase', async () => {
		const logger = new MockLogger();
		await logger.log({
			timestamp: '',
			event_id: 'a',
			trace_id: 't',
			phase: 'source.emit',
			source: 'test',
		});
		await logger.log({
			timestamp: '',
			event_id: 'b',
			trace_id: 't',
			phase: 'deliver.success',
			target: 'actor',
		});

		expect(logger.entriesForPhase('source.emit')).toHaveLength(1);
		expect(logger.entriesForPhase('deliver.success')).toHaveLength(1);
	});
});

describe('createTestEvent', () => {
	it('creates event with defaults', () => {
		const event = createTestEvent();
		expect(event.source).toBe('test-source');
		expect(event.type).toBe('resource.changed');
		expect(event.provenance.platform).toBe('test');
	});

	it('allows overrides', () => {
		const event = createTestEvent({ source: 'custom', type: 'actor.stopped' });
		expect(event.source).toBe('custom');
		expect(event.type).toBe('actor.stopped');
	});
});
