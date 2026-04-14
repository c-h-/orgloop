/**
 * Tests for the `selectRecentEvents` deduplication logic in `orgloop status`.
 *
 * Regression coverage for: https://github.com/c-h-personal/orgloop/issues/17
 * — STATUS column showed "drop" for events that were delivered via another route.
 */

import { selectRecentEvents } from '../commands/status.js';

function makeEntry(
	event_id: string,
	phase: string,
	timestamp: string,
	overrides: Record<string, string> = {},
) {
	return {
		timestamp,
		event_id,
		phase,
		source: 'test-source',
		event_type: 'resource.changed',
		...overrides,
	};
}

describe('selectRecentEvents', () => {
	it('returns deliver.success entries with status "success"', () => {
		const entries = [makeEntry('evt_1', 'deliver.success', '2024-01-01T00:00:01Z')];
		const result = selectRecentEvents(entries, 5);
		expect(result).toHaveLength(1);
		expect(result[0].phase).toBe('deliver.success');
	});

	it('returns transform.drop entries for events that were not delivered', () => {
		const entries = [makeEntry('evt_1', 'transform.drop', '2024-01-01T00:00:01Z')];
		const result = selectRecentEvents(entries, 5);
		expect(result).toHaveLength(1);
		expect(result[0].phase).toBe('transform.drop');
	});

	it('prefers deliver.success over transform.drop for the same event_id', () => {
		// An event matching two routes: one drops it, the other delivers it.
		const entries = [
			makeEntry('evt_1', 'transform.drop', '2024-01-01T00:00:01Z', { route: 'route-a' }),
			makeEntry('evt_1', 'deliver.success', '2024-01-01T00:00:02Z', { route: 'route-b' }),
		];
		const result = selectRecentEvents(entries, 5);
		expect(result).toHaveLength(1);
		expect(result[0].phase).toBe('deliver.success');
		expect(result[0].route).toBe('route-b');
	});

	it('prefers deliver.success even when it appears before transform.drop in log order', () => {
		const entries = [
			makeEntry('evt_1', 'deliver.success', '2024-01-01T00:00:01Z', { route: 'route-a' }),
			makeEntry('evt_1', 'transform.drop', '2024-01-01T00:00:02Z', { route: 'route-b' }),
		];
		const result = selectRecentEvents(entries, 5);
		expect(result).toHaveLength(1);
		expect(result[0].phase).toBe('deliver.success');
	});

	it('prefers deliver.failure over transform.drop for the same event_id', () => {
		const entries = [
			makeEntry('evt_1', 'transform.drop', '2024-01-01T00:00:01Z'),
			makeEntry('evt_1', 'deliver.failure', '2024-01-01T00:00:02Z'),
		];
		const result = selectRecentEvents(entries, 5);
		expect(result).toHaveLength(1);
		expect(result[0].phase).toBe('deliver.failure');
	});

	it('deduplicates multiple events independently', () => {
		const entries = [
			makeEntry('evt_1', 'transform.drop', '2024-01-01T00:00:01Z'),
			makeEntry('evt_1', 'deliver.success', '2024-01-01T00:00:02Z'),
			makeEntry('evt_2', 'transform.drop', '2024-01-01T00:00:03Z'),
			makeEntry('evt_3', 'deliver.success', '2024-01-01T00:00:04Z'),
		];
		const result = selectRecentEvents(entries, 5);
		expect(result).toHaveLength(3);
		const byId = Object.fromEntries(result.map((e) => [e.event_id, e.phase]));
		expect(byId.evt_1).toBe('deliver.success');
		expect(byId.evt_2).toBe('transform.drop');
		expect(byId.evt_3).toBe('deliver.success');
	});

	it('returns the most-recent `count` events by timestamp', () => {
		const entries = [
			makeEntry('evt_1', 'deliver.success', '2024-01-01T00:00:01Z'),
			makeEntry('evt_2', 'deliver.success', '2024-01-01T00:00:02Z'),
			makeEntry('evt_3', 'deliver.success', '2024-01-01T00:00:03Z'),
			makeEntry('evt_4', 'deliver.success', '2024-01-01T00:00:04Z'),
			makeEntry('evt_5', 'deliver.success', '2024-01-01T00:00:05Z'),
			makeEntry('evt_6', 'deliver.success', '2024-01-01T00:00:06Z'),
		];
		const result = selectRecentEvents(entries, 5);
		expect(result).toHaveLength(5);
		expect(result.map((e) => e.event_id)).toEqual(['evt_2', 'evt_3', 'evt_4', 'evt_5', 'evt_6']);
	});

	it('ignores entries with unrecognised phases', () => {
		const entries = [
			makeEntry('evt_1', 'source.emit', '2024-01-01T00:00:01Z'),
			makeEntry('evt_2', 'route.match', '2024-01-01T00:00:02Z'),
			makeEntry('evt_3', 'deliver.success', '2024-01-01T00:00:03Z'),
		];
		const result = selectRecentEvents(entries, 5);
		expect(result).toHaveLength(1);
		expect(result[0].event_id).toBe('evt_3');
	});

	it('returns empty array when no relevant entries', () => {
		const result = selectRecentEvents([], 5);
		expect(result).toHaveLength(0);
	});

	it('returns entries sorted oldest-first', () => {
		const entries = [
			makeEntry('evt_3', 'deliver.success', '2024-01-01T00:00:03Z'),
			makeEntry('evt_1', 'deliver.success', '2024-01-01T00:00:01Z'),
			makeEntry('evt_2', 'deliver.success', '2024-01-01T00:00:02Z'),
		];
		const result = selectRecentEvents(entries, 5);
		expect(result.map((e) => e.event_id)).toEqual(['evt_1', 'evt_2', 'evt_3']);
	});
});
