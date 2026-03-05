import type { EventRecord } from '../event-history.js';
import { EventHistory } from '../event-history.js';

function makeRecord(overrides: Partial<EventRecord> = {}): EventRecord {
	return {
		event_id: `evt_${Math.random().toString(36).slice(2)}`,
		timestamp: new Date().toISOString(),
		source: 'test-source',
		type: 'resource.changed',
		matched_routes: ['route-a'],
		sop_files: [],
		actors: ['actor-a'],
		processing_ms: 1.5,
		module: 'test-module',
		...overrides,
	};
}

describe('EventHistory', () => {
	it('stores and retrieves events', () => {
		const history = new EventHistory({ maxSize: 10 });
		const record = makeRecord();
		history.push(record);

		expect(history.size()).toBe(1);
		const results = history.query();
		expect(results).toHaveLength(1);
		expect(results[0].event_id).toBe(record.event_id);
	});

	it('returns events newest-first', () => {
		const history = new EventHistory({ maxSize: 10 });
		const r1 = makeRecord({ event_id: 'evt_1', timestamp: '2024-01-01T00:00:00Z' });
		const r2 = makeRecord({ event_id: 'evt_2', timestamp: '2024-01-01T00:01:00Z' });
		const r3 = makeRecord({ event_id: 'evt_3', timestamp: '2024-01-01T00:02:00Z' });

		history.push(r1);
		history.push(r2);
		history.push(r3);

		const results = history.query();
		expect(results.map((r) => r.event_id)).toEqual(['evt_3', 'evt_2', 'evt_1']);
	});

	it('evicts oldest entries when full', () => {
		const history = new EventHistory({ maxSize: 3 });
		history.push(makeRecord({ event_id: 'evt_1' }));
		history.push(makeRecord({ event_id: 'evt_2' }));
		history.push(makeRecord({ event_id: 'evt_3' }));
		history.push(makeRecord({ event_id: 'evt_4' }));

		expect(history.size()).toBe(3);
		const results = history.query();
		expect(results.map((r) => r.event_id)).toEqual(['evt_4', 'evt_3', 'evt_2']);
	});

	it('filters by source', () => {
		const history = new EventHistory({ maxSize: 10 });
		history.push(makeRecord({ source: 'github' }));
		history.push(makeRecord({ source: 'linear' }));
		history.push(makeRecord({ source: 'github' }));

		const results = history.query({ source: 'linear' });
		expect(results).toHaveLength(1);
		expect(results[0].source).toBe('linear');
	});

	it('filters by route', () => {
		const history = new EventHistory({ maxSize: 10 });
		history.push(makeRecord({ matched_routes: ['pr-review'] }));
		history.push(makeRecord({ matched_routes: ['ci-failure', 'notify'] }));
		history.push(makeRecord({ matched_routes: ['pr-review'] }));

		const results = history.query({ route: 'ci-failure' });
		expect(results).toHaveLength(1);
		expect(results[0].matched_routes).toContain('ci-failure');
	});

	it('filters by time range', () => {
		const history = new EventHistory({ maxSize: 10 });
		history.push(makeRecord({ timestamp: '2024-01-01T00:00:00Z' }));
		history.push(makeRecord({ timestamp: '2024-01-02T00:00:00Z' }));
		history.push(makeRecord({ timestamp: '2024-01-03T00:00:00Z' }));

		const results = history.query({
			from: '2024-01-01T12:00:00Z',
			to: '2024-01-02T12:00:00Z',
		});
		expect(results).toHaveLength(1);
		expect(results[0].timestamp).toBe('2024-01-02T00:00:00Z');
	});

	it('respects limit', () => {
		const history = new EventHistory({ maxSize: 10 });
		for (let i = 0; i < 5; i++) {
			history.push(makeRecord());
		}

		const results = history.query({ limit: 2 });
		expect(results).toHaveLength(2);
	});

	it('handles empty buffer', () => {
		const history = new EventHistory({ maxSize: 10 });
		expect(history.size()).toBe(0);
		expect(history.query()).toEqual([]);
	});

	it('defaults to maxSize 1000', () => {
		const history = new EventHistory();
		// Push 1001 records
		for (let i = 0; i < 1001; i++) {
			history.push(makeRecord({ event_id: `evt_${i}` }));
		}
		expect(history.size()).toBe(1000);
		// Oldest (evt_0) should be evicted
		const results = history.query();
		expect(results[results.length - 1].event_id).toBe('evt_1');
	});

	it('combines multiple filters', () => {
		const history = new EventHistory({ maxSize: 10 });
		history.push(makeRecord({ source: 'github', matched_routes: ['pr-review'] }));
		history.push(makeRecord({ source: 'github', matched_routes: ['ci-failure'] }));
		history.push(makeRecord({ source: 'linear', matched_routes: ['pr-review'] }));

		const results = history.query({ source: 'github', route: 'pr-review' });
		expect(results).toHaveLength(1);
		expect(results[0].source).toBe('github');
		expect(results[0].matched_routes).toContain('pr-review');
	});
});
