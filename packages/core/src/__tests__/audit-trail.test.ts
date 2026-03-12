import { createTestEvent, MockActor, MockSource } from '@orgloop/sdk';
import { describe, expect, it } from 'vitest';
import type { AuditRecord } from '../audit.js';
import { AuditTrail, contentHash, generateAuditId } from '../audit.js';
import { Runtime } from '../runtime.js';

// ─── Unit Tests: AuditTrail ──────────────────────────────────────────────────

describe('AuditTrail', () => {
	function makeRecord(overrides?: Partial<AuditRecord>): AuditRecord {
		return {
			id: generateAuditId(),
			timestamp: new Date().toISOString(),
			trace_id: 'trc_test',
			input_event_id: 'evt_test',
			input_source: 'test-source',
			input_type: 'resource.changed',
			input_content_hash: contentHash({ test: true }),
			route: 'test-route',
			sop_file: null,
			module: 'default',
			actor: 'test-actor',
			delivery_status: 'delivered',
			duration_ms: 42,
			outputs: [],
			chain_depth: 1,
			parent_event_id: null,
			held_for_review: false,
			flags: [],
			...overrides,
		};
	}

	it('records and retrieves audit entries', () => {
		const trail = new AuditTrail();
		const record = makeRecord();
		trail.record(record);

		expect(trail.size()).toBe(1);
		const results = trail.query();
		expect(results).toHaveLength(1);
		expect(results[0].id).toBe(record.id);
	});

	it('respects maxSize ring buffer limit', () => {
		const trail = new AuditTrail({ maxSize: 3 });

		for (let i = 0; i < 5; i++) {
			trail.record(makeRecord({ input_event_id: `evt_${i}` }));
		}

		expect(trail.size()).toBe(3);
		const results = trail.query();
		// Newest first, so we should see evt_4, evt_3, evt_2
		expect(results[0].input_event_id).toBe('evt_4');
		expect(results[2].input_event_id).toBe('evt_2');
	});

	it('filters by trace_id', () => {
		const trail = new AuditTrail();
		trail.record(makeRecord({ trace_id: 'trc_a' }));
		trail.record(makeRecord({ trace_id: 'trc_b' }));
		trail.record(makeRecord({ trace_id: 'trc_a' }));

		const results = trail.query({ trace_id: 'trc_a' });
		expect(results).toHaveLength(2);
		expect(results.every((r) => r.trace_id === 'trc_a')).toBe(true);
	});

	it('filters by route', () => {
		const trail = new AuditTrail();
		trail.record(makeRecord({ route: 'route-a' }));
		trail.record(makeRecord({ route: 'route-b' }));

		const results = trail.query({ route: 'route-a' });
		expect(results).toHaveLength(1);
		expect(results[0].route).toBe('route-a');
	});

	it('filters by actor', () => {
		const trail = new AuditTrail();
		trail.record(makeRecord({ actor: 'actor-a' }));
		trail.record(makeRecord({ actor: 'actor-b' }));

		const results = trail.query({ actor: 'actor-a' });
		expect(results).toHaveLength(1);
	});

	it('filters flagged_only', () => {
		const trail = new AuditTrail();
		trail.record(makeRecord({ flags: [] }));
		trail.record(
			makeRecord({
				flags: [{ type: 'instruction_content', severity: 'critical', message: 'test' }],
			}),
		);

		const results = trail.query({ flagged_only: true });
		expect(results).toHaveLength(1);
		expect(results[0].flags).toHaveLength(1);
	});

	it('filters held_only', () => {
		const trail = new AuditTrail();
		trail.record(makeRecord({ held_for_review: false }));
		trail.record(makeRecord({ held_for_review: true }));

		const results = trail.query({ held_only: true });
		expect(results).toHaveLength(1);
		expect(results[0].held_for_review).toBe(true);
	});

	it('respects limit', () => {
		const trail = new AuditTrail();
		for (let i = 0; i < 10; i++) {
			trail.record(makeRecord());
		}

		const results = trail.query({ limit: 3 });
		expect(results).toHaveLength(3);
	});

	it('getChain returns records for a trace', () => {
		const trail = new AuditTrail();
		trail.record(makeRecord({ trace_id: 'trc_chain', chain_depth: 1 }));
		trail.record(makeRecord({ trace_id: 'trc_chain', chain_depth: 2 }));
		trail.record(makeRecord({ trace_id: 'trc_other', chain_depth: 1 }));

		const chain = trail.getChain('trc_chain');
		expect(chain).toHaveLength(2);
	});
});

// ─── Unit Tests: contentHash ─────────────────────────────────────────────────

describe('contentHash', () => {
	it('produces consistent hashes', () => {
		const h1 = contentHash({ a: 1, b: 'hello' });
		const h2 = contentHash({ a: 1, b: 'hello' });
		expect(h1).toBe(h2);
	});

	it('produces different hashes for different content', () => {
		const h1 = contentHash({ a: 1 });
		const h2 = contentHash({ a: 2 });
		expect(h1).not.toBe(h2);
	});

	it('produces hex string of correct length (SHA-256)', () => {
		const h = contentHash('test');
		expect(h).toMatch(/^[a-f0-9]{64}$/);
	});
});

// ─── Unit Tests: generateAuditId ─────────────────────────────────────────────

describe('generateAuditId', () => {
	it('produces unique IDs with aud_ prefix', () => {
		const id1 = generateAuditId();
		const id2 = generateAuditId();
		expect(id1).toMatch(/^aud_/);
		expect(id2).toMatch(/^aud_/);
		expect(id1).not.toBe(id2);
	});
});

// ─── Integration Tests: Audit Trail in Runtime ──────────────────────────────

describe('Audit trail integration', () => {
	function makeConfig(overrides?: Partial<OrgLoopConfig>): OrgLoopConfig {
		return {
			project: { name: 'audit-test' },
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

	it('records audit entries for delivered events', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const runtime = new Runtime();
		await runtime.start();
		await runtime.loadModule(
			{
				name: 'default',
				sources: makeConfig().sources,
				actors: makeConfig().actors,
				routes: makeConfig().routes,
				transforms: [],
				loggers: [],
			},
			{
				sources: new Map([['test-source', source]]),
				actors: new Map([['test-actor', actor]]),
			},
		);

		const event = createTestEvent({
			source: 'test-source',
			type: 'resource.changed',
		});

		await runtime.inject(event);

		const records = runtime.queryAuditTrail();
		expect(records).toHaveLength(1);
		expect(records[0].input_event_id).toBe(event.id);
		expect(records[0].input_source).toBe('test-source');
		expect(records[0].route).toBe('test-route');
		expect(records[0].actor).toBe('test-actor');
		expect(records[0].delivery_status).toBe('delivered');
		expect(records[0].input_content_hash).toBeTruthy();
		expect(records[0].chain_depth).toBeGreaterThanOrEqual(1);

		await runtime.stop();
	});

	it('records audit entries with SOP file reference', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const runtime = new Runtime();
		await runtime.start();
		await runtime.loadModule(
			{
				name: 'default',
				sources: makeConfig().sources,
				actors: makeConfig().actors,
				routes: [
					{
						name: 'sop-route',
						when: { source: 'test-source', events: ['resource.changed'] },
						then: { actor: 'test-actor' },
						with: { prompt_file: '/nonexistent/sop.md' },
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

		const event = createTestEvent({
			source: 'test-source',
			type: 'resource.changed',
		});

		await runtime.inject(event);

		const records = runtime.queryAuditTrail();
		expect(records).toHaveLength(1);
		expect(records[0].sop_file).toBe('/nonexistent/sop.md');

		await runtime.stop();
	});

	it('returns audit records filtered by flagged_only', async () => {
		const source = new MockSource('test-source');
		const actor = new MockActor('test-actor');

		const runtime = new Runtime();
		await runtime.start();
		await runtime.loadModule(
			{
				name: 'default',
				sources: makeConfig().sources,
				actors: makeConfig().actors,
				routes: makeConfig().routes,
				transforms: [],
				loggers: [],
			},
			{
				sources: new Map([['test-source', source]]),
				actors: new Map([['test-actor', actor]]),
			},
		);

		// Inject a clean event
		const event = createTestEvent({
			source: 'test-source',
			type: 'resource.changed',
			payload: { action: 'opened' },
		});
		await runtime.inject(event);

		// Clean events should have no flags
		const flagged = runtime.queryAuditTrail({ flagged_only: true });
		expect(flagged).toHaveLength(0);

		const all = runtime.queryAuditTrail();
		expect(all).toHaveLength(1);

		await runtime.stop();
	});

	it('exposes audit trail and loop detector instances', async () => {
		const runtime = new Runtime();
		expect(runtime.getAuditTrail()).toBeTruthy();
		expect(runtime.getLoopDetector()).toBeTruthy();
		expect(runtime.getOutputValidator()).toBeTruthy();
	});
});
