import type { SourceConfig } from '@orgloop/sdk';
import {
	CronSource,
	cronMatchesDate,
	findLastMatch,
	parseCronExpression,
	parseCronField,
	parseInterval,
} from '../source.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(schedules: unknown[]): SourceConfig {
	return {
		id: 'test-cron',
		connector: 'cron',
		config: { schedules },
	};
}

function sorted(set: Set<number>): number[] {
	return [...set].sort((a, b) => a - b);
}

// ─── parseCronField ──────────────────────────────────────────────────────────

describe('parseCronField', () => {
	describe('wildcard (*)', () => {
		it('produces all values for minutes (0-59)', () => {
			const result = parseCronField('*', 0, 59);
			expect(result.size).toBe(60);
			expect(result.has(0)).toBe(true);
			expect(result.has(59)).toBe(true);
		});

		it('produces all values for hours (0-23)', () => {
			const result = parseCronField('*', 0, 23);
			expect(result.size).toBe(24);
		});

		it('produces all values for days of month (1-31)', () => {
			const result = parseCronField('*', 1, 31);
			expect(result.size).toBe(31);
			expect(result.has(0)).toBe(false);
			expect(result.has(1)).toBe(true);
			expect(result.has(31)).toBe(true);
		});

		it('produces all values for months (1-12)', () => {
			const result = parseCronField('*', 1, 12);
			expect(result.size).toBe(12);
		});

		it('produces all values for days of week (0-6)', () => {
			const result = parseCronField('*', 0, 6);
			expect(result.size).toBe(7);
		});
	});

	describe('single values', () => {
		it('parses a single value within range', () => {
			expect(sorted(parseCronField('5', 0, 59))).toEqual([5]);
		});

		it('parses boundary value (min)', () => {
			expect(sorted(parseCronField('0', 0, 59))).toEqual([0]);
		});

		it('parses boundary value (max)', () => {
			expect(sorted(parseCronField('59', 0, 59))).toEqual([59]);
		});

		it('throws on value below min', () => {
			expect(() => parseCronField('0', 1, 31)).toThrow('Invalid value');
		});

		it('throws on value above max', () => {
			expect(() => parseCronField('60', 0, 59)).toThrow('Invalid value');
		});

		it('throws on non-numeric value', () => {
			expect(() => parseCronField('abc', 0, 59)).toThrow('Invalid value');
		});
	});

	describe('ranges (N-M)', () => {
		it('parses a simple range', () => {
			expect(sorted(parseCronField('1-5', 0, 6))).toEqual([1, 2, 3, 4, 5]);
		});

		it('parses range at min boundary', () => {
			expect(sorted(parseCronField('0-2', 0, 59))).toEqual([0, 1, 2]);
		});

		it('parses range at max boundary', () => {
			expect(sorted(parseCronField('57-59', 0, 59))).toEqual([57, 58, 59]);
		});

		it('parses single-value range (N-N)', () => {
			expect(sorted(parseCronField('5-5', 0, 59))).toEqual([5]);
		});

		it('throws when range start is below min', () => {
			expect(() => parseCronField('0-5', 1, 31)).toThrow('Range out of bounds');
		});

		it('throws when range end exceeds max', () => {
			expect(() => parseCronField('0-60', 0, 59)).toThrow('Range out of bounds');
		});
	});

	describe('steps (*/N)', () => {
		it('parses */15 for minutes', () => {
			expect(sorted(parseCronField('*/15', 0, 59))).toEqual([0, 15, 30, 45]);
		});

		it('parses */5 for minutes', () => {
			const result = sorted(parseCronField('*/5', 0, 59));
			expect(result).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
		});

		it('parses */2 for hours', () => {
			expect(sorted(parseCronField('*/2', 0, 23))).toEqual([
				0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22,
			]);
		});

		it('parses */3 for months', () => {
			expect(sorted(parseCronField('*/3', 1, 12))).toEqual([1, 4, 7, 10]);
		});

		it('throws on step of 0', () => {
			expect(() => parseCronField('*/0', 0, 59)).toThrow('Invalid step value');
		});
	});

	describe('range with steps (N-M/S)', () => {
		it('parses 9-17/2 for hours', () => {
			expect(sorted(parseCronField('9-17/2', 0, 23))).toEqual([9, 11, 13, 15, 17]);
		});

		it('parses 1-5/2 for days of week', () => {
			expect(sorted(parseCronField('1-5/2', 0, 6))).toEqual([1, 3, 5]);
		});

		it('throws on range/step with out-of-bounds start', () => {
			expect(() => parseCronField('0-5/2', 1, 31)).toThrow('Invalid range/step');
		});

		it('throws on range/step with out-of-bounds end', () => {
			expect(() => parseCronField('0-60/5', 0, 59)).toThrow('Invalid range/step');
		});

		it('throws on range/step with step of 0', () => {
			expect(() => parseCronField('1-5/0', 0, 6)).toThrow('Invalid range/step');
		});
	});

	describe('comma-separated lists', () => {
		it('parses simple list', () => {
			expect(sorted(parseCronField('1,3,5', 0, 6))).toEqual([1, 3, 5]);
		});

		it('parses list with range', () => {
			expect(sorted(parseCronField('1-3,5', 0, 6))).toEqual([1, 2, 3, 5]);
		});

		it('parses list with step', () => {
			expect(sorted(parseCronField('*/10,25', 0, 59))).toEqual([0, 10, 20, 25, 30, 40, 50]);
		});

		it('deduplicates overlapping values', () => {
			const result = sorted(parseCronField('1-3,2-4', 0, 6));
			expect(result).toEqual([1, 2, 3, 4]);
		});
	});
});

// ─── parseCronExpression ─────────────────────────────────────────────────────

describe('parseCronExpression', () => {
	it('parses "* * * * *" (every minute)', () => {
		const f = parseCronExpression('* * * * *');
		expect(f.minutes.size).toBe(60);
		expect(f.hours.size).toBe(24);
		expect(f.daysOfMonth.size).toBe(31);
		expect(f.months.size).toBe(12);
		expect(f.daysOfWeek.size).toBe(7);
	});

	it('parses "0 9 * * *" (9 AM daily)', () => {
		const f = parseCronExpression('0 9 * * *');
		expect(sorted(f.minutes)).toEqual([0]);
		expect(sorted(f.hours)).toEqual([9]);
		expect(f.daysOfMonth.size).toBe(31);
		expect(f.months.size).toBe(12);
		expect(f.daysOfWeek.size).toBe(7);
	});

	it('parses "0 9 * * 1-5" (9 AM weekdays)', () => {
		const f = parseCronExpression('0 9 * * 1-5');
		expect(sorted(f.minutes)).toEqual([0]);
		expect(sorted(f.hours)).toEqual([9]);
		expect(sorted(f.daysOfWeek)).toEqual([1, 2, 3, 4, 5]);
	});

	it('parses "*/15 * * * *" (every 15 minutes)', () => {
		const f = parseCronExpression('*/15 * * * *');
		expect(sorted(f.minutes)).toEqual([0, 15, 30, 45]);
	});

	it('parses "0 */2 * * *" (every 2 hours)', () => {
		const f = parseCronExpression('0 */2 * * *');
		expect(sorted(f.minutes)).toEqual([0]);
		expect(sorted(f.hours)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
	});

	it('parses "0 9-17/2 * * *" (every 2 hours during business hours)', () => {
		const f = parseCronExpression('0 9-17/2 * * *');
		expect(sorted(f.hours)).toEqual([9, 11, 13, 15, 17]);
	});

	it('parses "0 9,12,17 * * *" (specific hours)', () => {
		const f = parseCronExpression('0 9,12,17 * * *');
		expect(sorted(f.hours)).toEqual([9, 12, 17]);
	});

	it('parses "0 0 1 * *" (1st of every month)', () => {
		const f = parseCronExpression('0 0 1 * *');
		expect(sorted(f.minutes)).toEqual([0]);
		expect(sorted(f.hours)).toEqual([0]);
		expect(sorted(f.daysOfMonth)).toEqual([1]);
	});

	it('parses "0 0 15 * *" (15th of every month)', () => {
		const f = parseCronExpression('0 0 15 * *');
		expect(sorted(f.daysOfMonth)).toEqual([15]);
	});

	it('parses "0 0 1 1 *" (Jan 1st midnight)', () => {
		const f = parseCronExpression('0 0 1 1 *');
		expect(sorted(f.daysOfMonth)).toEqual([1]);
		expect(sorted(f.months)).toEqual([1]);
	});

	it('parses "0 0 1 */3 *" (quarterly, 1st of every 3rd month)', () => {
		const f = parseCronExpression('0 0 1 */3 *');
		expect(sorted(f.months)).toEqual([1, 4, 7, 10]);
	});

	it('parses "0 0 * * 0" (Sunday midnight)', () => {
		const f = parseCronExpression('0 0 * * 0');
		expect(sorted(f.daysOfWeek)).toEqual([0]);
	});

	it('parses "0 0 * * 1,3,5" (Mon, Wed, Fri midnight)', () => {
		const f = parseCronExpression('0 0 * * 1,3,5');
		expect(sorted(f.daysOfWeek)).toEqual([1, 3, 5]);
	});

	it('throws on too few fields', () => {
		expect(() => parseCronExpression('* * *')).toThrow('Expected 5 fields');
	});

	it('throws on too many fields', () => {
		expect(() => parseCronExpression('* * * * * *')).toThrow('Expected 5 fields');
	});

	it('throws on empty string', () => {
		expect(() => parseCronExpression('')).toThrow('Expected 5 fields');
	});

	it('throws on invalid value in a field', () => {
		expect(() => parseCronExpression('60 * * * *')).toThrow('Invalid value');
	});

	it('throws on invalid range in a field', () => {
		expect(() => parseCronExpression('* 0-25 * * *')).toThrow('Range out of bounds');
	});
});

// ─── parseInterval ───────────────────────────────────────────────────────────

describe('parseInterval', () => {
	describe('"every" prefix format', () => {
		it('parses "every 5m"', () => {
			expect(parseInterval('every 5m')).toBe(5 * 60_000);
		});

		it('parses "every 30s"', () => {
			expect(parseInterval('every 30s')).toBe(30_000);
		});

		it('parses "every 1h"', () => {
			expect(parseInterval('every 1h')).toBe(60 * 60_000);
		});

		it('parses "every 2d"', () => {
			expect(parseInterval('every 2d')).toBe(2 * 24 * 60 * 60_000);
		});

		it('parses "every 500ms"', () => {
			expect(parseInterval('every 500ms')).toBe(500);
		});

		it('is case-insensitive on "every"', () => {
			expect(parseInterval('Every 10m')).toBe(10 * 60_000);
			expect(parseInterval('EVERY 10m')).toBe(10 * 60_000);
		});
	});

	describe('shorthand (bare duration)', () => {
		it('parses "5m"', () => {
			expect(parseInterval('5m')).toBe(5 * 60_000);
		});

		it('parses "1h"', () => {
			expect(parseInterval('1h')).toBe(60 * 60_000);
		});

		it('parses "30s"', () => {
			expect(parseInterval('30s')).toBe(30_000);
		});

		it('parses "7d"', () => {
			expect(parseInterval('7d')).toBe(7 * 24 * 60 * 60_000);
		});
	});

	describe('error cases', () => {
		it('throws on invalid format', () => {
			expect(() => parseInterval('every bad')).toThrow('Invalid duration');
		});

		it('throws on bare invalid string', () => {
			expect(() => parseInterval('nope')).toThrow('Invalid duration');
		});
	});
});

// ─── cronMatchesDate ─────────────────────────────────────────────────────────

describe('cronMatchesDate', () => {
	it('matches "0 9 * * 1-5" on Monday 9:00 AM', () => {
		const fields = parseCronExpression('0 9 * * 1-5');
		// 2026-02-09 is a Monday
		expect(cronMatchesDate(fields, new Date(2026, 1, 9, 9, 0, 0))).toBe(true);
	});

	it('does not match "0 9 * * 1-5" on Saturday', () => {
		const fields = parseCronExpression('0 9 * * 1-5');
		// 2026-02-07 is a Saturday
		expect(cronMatchesDate(fields, new Date(2026, 1, 7, 9, 0, 0))).toBe(false);
	});

	it('does not match wrong hour', () => {
		const fields = parseCronExpression('0 9 * * 1-5');
		expect(cronMatchesDate(fields, new Date(2026, 1, 9, 10, 0, 0))).toBe(false);
	});

	it('does not match wrong minute', () => {
		const fields = parseCronExpression('0 9 * * 1-5');
		expect(cronMatchesDate(fields, new Date(2026, 1, 9, 9, 1, 0))).toBe(false);
	});

	it('matches "*/15 * * * *" at minute 0', () => {
		const fields = parseCronExpression('*/15 * * * *');
		expect(cronMatchesDate(fields, new Date(2026, 0, 1, 0, 0, 0))).toBe(true);
	});

	it('matches "*/15 * * * *" at minute 30', () => {
		const fields = parseCronExpression('*/15 * * * *');
		expect(cronMatchesDate(fields, new Date(2026, 1, 9, 14, 30, 0))).toBe(true);
	});

	it('does not match "*/15 * * * *" at minute 7', () => {
		const fields = parseCronExpression('*/15 * * * *');
		expect(cronMatchesDate(fields, new Date(2026, 1, 9, 14, 7, 0))).toBe(false);
	});

	it('matches "* * * * *" on any date', () => {
		const fields = parseCronExpression('* * * * *');
		expect(cronMatchesDate(fields, new Date(2026, 5, 15, 3, 42, 0))).toBe(true);
		expect(cronMatchesDate(fields, new Date(2026, 11, 31, 23, 59, 0))).toBe(true);
	});

	it('matches "0 0 1 1 *" only on Jan 1st midnight', () => {
		const fields = parseCronExpression('0 0 1 1 *');
		expect(cronMatchesDate(fields, new Date(2026, 0, 1, 0, 0, 0))).toBe(true);
		expect(cronMatchesDate(fields, new Date(2026, 0, 2, 0, 0, 0))).toBe(false);
		expect(cronMatchesDate(fields, new Date(2026, 1, 1, 0, 0, 0))).toBe(false);
	});

	it('matches day-of-month correctly for "0 0 15 * *"', () => {
		const fields = parseCronExpression('0 0 15 * *');
		expect(cronMatchesDate(fields, new Date(2026, 2, 15, 0, 0, 0))).toBe(true);
		expect(cronMatchesDate(fields, new Date(2026, 2, 14, 0, 0, 0))).toBe(false);
	});

	it('matches quarterly schedule "0 0 1 */3 *"', () => {
		const fields = parseCronExpression('0 0 1 */3 *');
		// Jan 1, Apr 1, Jul 1, Oct 1 at midnight
		expect(cronMatchesDate(fields, new Date(2026, 0, 1, 0, 0, 0))).toBe(true); // Jan
		expect(cronMatchesDate(fields, new Date(2026, 3, 1, 0, 0, 0))).toBe(true); // Apr
		expect(cronMatchesDate(fields, new Date(2026, 6, 1, 0, 0, 0))).toBe(true); // Jul
		expect(cronMatchesDate(fields, new Date(2026, 9, 1, 0, 0, 0))).toBe(true); // Oct
		expect(cronMatchesDate(fields, new Date(2026, 1, 1, 0, 0, 0))).toBe(false); // Feb
	});
});

// ─── findLastMatch ───────────────────────────────────────────────────────────

describe('findLastMatch', () => {
	it('finds a match within a 2-hour window', () => {
		const fields = parseCronExpression('0 * * * *'); // top of every hour
		const after = new Date(2026, 1, 9, 8, 0, 1); // just after 8:00
		const before = new Date(2026, 1, 9, 10, 30, 0);
		const match = findLastMatch(fields, after, before);
		expect(match).not.toBeNull();
		expect(match?.getHours()).toBe(10);
		expect(match?.getMinutes()).toBe(0);
	});

	it('returns null when no match exists in window', () => {
		const fields = parseCronExpression('0 9 * * 1-5'); // 9 AM weekdays
		// Saturday 10 AM to Saturday 11 AM — no match possible
		const after = new Date(2026, 1, 7, 10, 0, 0);
		const before = new Date(2026, 1, 7, 11, 0, 0);
		expect(findLastMatch(fields, after, before)).toBeNull();
	});

	it('finds exact boundary match (at before time)', () => {
		const fields = parseCronExpression('30 14 * * *'); // 2:30 PM daily
		const after = new Date(2026, 1, 9, 14, 29, 0);
		const before = new Date(2026, 1, 9, 14, 30, 0);
		const match = findLastMatch(fields, after, before);
		expect(match).not.toBeNull();
		expect(match?.getHours()).toBe(14);
		expect(match?.getMinutes()).toBe(30);
	});

	it('excludes matches at the exact after time (exclusive lower bound)', () => {
		const fields = parseCronExpression('0 9 * * *'); // 9:00 AM
		// after IS 9:00:00.000 exactly — should still include 9:00 since seconds=0, ms=0
		const after = new Date(2026, 1, 9, 9, 0, 0, 0);
		const before = new Date(2026, 1, 9, 9, 0, 30);
		const match = findLastMatch(fields, after, before);
		// start aligns to 9:00 since no seconds/ms to round up
		expect(match).not.toBeNull();
	});

	it('rounds up after-time when it has seconds', () => {
		const fields = parseCronExpression('0 9 * * *'); // 9:00 AM
		// after is 9:00:01 — rounds up to 9:01, so 9:00 is excluded
		const after = new Date(2026, 1, 9, 9, 0, 1);
		const before = new Date(2026, 1, 9, 9, 0, 30);
		// Window is [9:01, 9:00] — start > end, no match
		expect(findLastMatch(fields, after, before)).toBeNull();
	});

	describe('backward scan after downtime', () => {
		it('finds match after short downtime (5 minutes)', () => {
			const fields = parseCronExpression('*/5 * * * *'); // every 5 minutes
			const after = new Date(2026, 1, 9, 10, 0, 1); // 10:00:01
			const before = new Date(2026, 1, 9, 10, 5, 0); // 10:05:00
			const match = findLastMatch(fields, after, before);
			expect(match).not.toBeNull();
			expect(match?.getMinutes()).toBe(5);
		});

		it('finds match after long downtime (1 day)', () => {
			const fields = parseCronExpression('0 9 * * *'); // 9 AM daily
			const after = new Date(2026, 1, 8, 9, 0, 1); // Feb 8 9:00:01
			const before = new Date(2026, 1, 9, 12, 0, 0); // Feb 9 12:00
			const match = findLastMatch(fields, after, before);
			expect(match).not.toBeNull();
			// Should find Feb 9 9:00 (the most recent match)
			expect(match?.getDate()).toBe(9);
			expect(match?.getHours()).toBe(9);
		});

		it('handles month boundary (Jan 31 to Feb 1)', () => {
			const fields = parseCronExpression('0 0 * * *'); // midnight daily
			const after = new Date(2026, 0, 31, 0, 0, 1); // Jan 31 00:00:01
			const before = new Date(2026, 1, 1, 1, 0, 0); // Feb 1 01:00
			const match = findLastMatch(fields, after, before);
			expect(match).not.toBeNull();
			expect(match?.getMonth()).toBe(1); // Feb
			expect(match?.getDate()).toBe(1);
			expect(match?.getHours()).toBe(0);
		});

		it('handles year boundary (Dec 31 to Jan 1)', () => {
			const fields = parseCronExpression('0 0 * * *'); // midnight daily
			const after = new Date(2025, 11, 31, 0, 0, 1); // Dec 31 00:00:01
			const before = new Date(2026, 0, 1, 1, 0, 0); // Jan 1 01:00
			const match = findLastMatch(fields, after, before);
			expect(match).not.toBeNull();
			expect(match?.getFullYear()).toBe(2026);
			expect(match?.getMonth()).toBe(0); // Jan
			expect(match?.getDate()).toBe(1);
		});

		it('finds monthly schedule across month boundary', () => {
			const fields = parseCronExpression('0 0 1 * *'); // 1st of month
			const after = new Date(2026, 0, 2, 0, 0, 0); // Jan 2
			const before = new Date(2026, 1, 1, 1, 0, 0); // Feb 1 01:00
			const match = findLastMatch(fields, after, before);
			expect(match).not.toBeNull();
			expect(match?.getMonth()).toBe(1); // Feb
			expect(match?.getDate()).toBe(1);
		});
	});
});

// ─── CronSource — init ───────────────────────────────────────────────────────

describe('CronSource', () => {
	describe('init', () => {
		it('throws if schedules is empty', async () => {
			const source = new CronSource();
			await expect(source.init(makeConfig([]))).rejects.toThrow('at least one schedule');
		});

		it('throws if schedules is missing', async () => {
			const source = new CronSource();
			const config: SourceConfig = {
				id: 'test',
				connector: 'cron',
				config: {},
			};
			await expect(source.init(config)).rejects.toThrow('at least one schedule');
		});

		it('initializes with an interval schedule', async () => {
			const source = new CronSource();
			await expect(
				source.init(makeConfig([{ name: 'heartbeat', cron: 'every 5m' }])),
			).resolves.toBeUndefined();
		});

		it('initializes with a cron expression schedule', async () => {
			const source = new CronSource();
			await expect(
				source.init(makeConfig([{ name: 'standup', cron: '0 9 * * 1-5' }])),
			).resolves.toBeUndefined();
		});

		it('initializes with a shorthand interval', async () => {
			const source = new CronSource();
			await expect(
				source.init(makeConfig([{ name: 'check', cron: '5m' }])),
			).resolves.toBeUndefined();
		});

		it('initializes with multiple schedules', async () => {
			const source = new CronSource();
			await expect(
				source.init(
					makeConfig([
						{ name: 'fast', cron: 'every 1m' },
						{ name: 'slow', cron: '0 9 * * *' },
					]),
				),
			).resolves.toBeUndefined();
		});

		it('throws on invalid cron expression', async () => {
			const source = new CronSource();
			await expect(source.init(makeConfig([{ name: 'bad', cron: '* * *' }]))).rejects.toThrow(
				'Expected 5 fields',
			);
		});
	});

	// ─── Event emission ──────────────────────────────────────────────────────

	describe('event emission', () => {
		it('emits events with correct type (resource.changed)', async () => {
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'test', cron: 'every 1m' }]));
			const result = await source.poll(null);
			expect(result.events[0].type).toBe('resource.changed');
		});

		it('emits events with correct platform provenance', async () => {
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'test', cron: 'every 1m' }]));
			const result = await source.poll(null);
			expect(result.events[0].provenance.platform).toBe('cron');
		});

		it('emits events with correct platform_event', async () => {
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'my-schedule', cron: 'every 1m' }]));
			const result = await source.poll(null);
			expect(result.events[0].provenance.platform_event).toBe('schedule.my-schedule');
		});

		it('emits events with author_type "system"', async () => {
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'test', cron: 'every 1m' }]));
			const result = await source.poll(null);
			expect(result.events[0].provenance.author_type).toBe('system');
		});

		it('emits events with source ID from config', async () => {
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'test', cron: 'every 1m' }]));
			const result = await source.poll(null);
			expect(result.events[0].source).toBe('test-cron');
		});

		it('emits events with evt_ prefixed IDs', async () => {
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'test', cron: 'every 1m' }]));
			const result = await source.poll(null);
			expect(result.events[0].id).toMatch(/^evt_/);
		});

		it('emits events with ISO 8601 timestamp', async () => {
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'test', cron: 'every 1m' }]));
			const result = await source.poll(null);
			expect(() => new Date(result.events[0].timestamp)).not.toThrow();
			expect(result.events[0].timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
		});

		it('emits events with trc_ prefixed trace ID', async () => {
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'test', cron: 'every 1m' }]));
			const result = await source.poll(null);
			expect(result.events[0].trace_id).toMatch(/^trc_/);
		});

		it('includes schedule name in payload', async () => {
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'heartbeat', cron: 'every 1m' }]));
			const result = await source.poll(null);
			expect(result.events[0].payload.schedule).toBe('heartbeat');
		});

		it('includes interval_ms in payload for interval schedules', async () => {
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'test', cron: 'every 5m' }]));
			const result = await source.poll(null);
			expect(result.events[0].payload.interval_ms).toBe(5 * 60_000);
		});

		it('does not include interval_ms for cron expression schedules', async () => {
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'test', cron: '* * * * *' }]));
			const result = await source.poll(null);
			expect(result.events[0].payload.interval_ms).toBeUndefined();
		});

		it('includes custom payload fields', async () => {
			const source = new CronSource();
			await source.init(
				makeConfig([
					{
						name: 'deploy',
						cron: 'every 1m',
						payload: { env: 'production', team: 'platform' },
					},
				]),
			);
			const result = await source.poll(null);
			expect(result.events[0].payload.env).toBe('production');
			expect(result.events[0].payload.team).toBe('platform');
			expect(result.events[0].payload.schedule).toBe('deploy');
		});

		it('multiple schedules produce independent events', async () => {
			const source = new CronSource();
			await source.init(
				makeConfig([
					{ name: 'alpha', cron: 'every 1m', payload: { tag: 'a' } },
					{ name: 'beta', cron: 'every 1m', payload: { tag: 'b' } },
				]),
			);
			const result = await source.poll(null);
			expect(result.events).toHaveLength(2);

			const alpha = result.events.find((e) => e.payload.schedule === 'alpha');
			const beta = result.events.find((e) => e.payload.schedule === 'beta');
			expect(alpha).toBeDefined();
			expect(beta).toBeDefined();
			expect(alpha?.payload.tag).toBe('a');
			expect(beta?.payload.tag).toBe('b');
			expect(alpha?.provenance.platform_event).toBe('schedule.alpha');
			expect(beta?.provenance.platform_event).toBe('schedule.beta');
			// Each event should have a unique ID
			expect(alpha?.id).not.toBe(beta?.id);
		});
	});

	// ─── Interval matching logic ─────────────────────────────────────────────

	describe('interval matching', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('fires on first poll with no checkpoint', async () => {
			vi.setSystemTime(new Date(2026, 1, 9, 12, 0, 0));
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'heartbeat', cron: 'every 5m' }]));

			const result = await source.poll(null);
			expect(result.events).toHaveLength(1);
		});

		it('does not fire when interval has not elapsed', async () => {
			vi.setSystemTime(new Date(2026, 1, 9, 12, 0, 0));
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'heartbeat', cron: 'every 5m' }]));

			const first = await source.poll(null);
			expect(first.events).toHaveLength(1);

			// Advance 2 minutes — not enough
			vi.advanceTimersByTime(2 * 60_000);
			const second = await source.poll(first.checkpoint);
			expect(second.events).toHaveLength(0);
		});

		it('fires when interval has elapsed', async () => {
			vi.setSystemTime(new Date(2026, 1, 9, 12, 0, 0));
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'heartbeat', cron: 'every 5m' }]));

			const first = await source.poll(null);

			// Advance exactly 5 minutes
			vi.advanceTimersByTime(5 * 60_000);
			const second = await source.poll(first.checkpoint);
			expect(second.events).toHaveLength(1);
		});

		it('fires when more than interval has elapsed', async () => {
			vi.setSystemTime(new Date(2026, 1, 9, 12, 0, 0));
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'heartbeat', cron: 'every 5m' }]));

			const first = await source.poll(null);

			// Advance 10 minutes — well past the interval
			vi.advanceTimersByTime(10 * 60_000);
			const second = await source.poll(first.checkpoint);
			expect(second.events).toHaveLength(1);
		});

		it('tracks multiple interval schedules independently', async () => {
			vi.setSystemTime(new Date(2026, 1, 9, 12, 0, 0));
			const source = new CronSource();
			await source.init(
				makeConfig([
					{ name: 'fast', cron: 'every 1m' },
					{ name: 'slow', cron: 'every 1h' },
				]),
			);

			// Both fire on first poll
			const first = await source.poll(null);
			expect(first.events).toHaveLength(2);

			// Advance 2 minutes — only 'fast' should fire
			vi.advanceTimersByTime(2 * 60_000);
			const second = await source.poll(first.checkpoint);
			expect(second.events).toHaveLength(1);
			expect(second.events[0].payload.schedule).toBe('fast');
		});
	});

	// ─── Cron expression matching ────────────────────────────────────────────

	describe('cron matching', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('fires cron schedule on first poll (no checkpoint)', async () => {
			vi.setSystemTime(new Date(2026, 1, 9, 12, 0, 0));
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'test', cron: '* * * * *' }]));

			const result = await source.poll(null);
			expect(result.events).toHaveLength(1);
		});

		it('fires when cron time passed since last checkpoint', async () => {
			// Set time to Monday 9:05 AM
			vi.setSystemTime(new Date(2026, 1, 9, 9, 5, 0));
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'standup', cron: '0 9 * * 1-5' }]));

			// Checkpoint from 8:55 AM — 9:00 AM is between checkpoint and now
			const checkpoint = JSON.stringify({
				standup: new Date(2026, 1, 9, 8, 55, 0).toISOString(),
			});
			const result = await source.poll(checkpoint);
			expect(result.events).toHaveLength(1);
			expect(result.events[0].payload.schedule).toBe('standup');
		});

		it('does not fire when no cron time in window', async () => {
			// Set time to Monday 8:58 AM
			vi.setSystemTime(new Date(2026, 1, 9, 8, 58, 0));
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'standup', cron: '0 9 * * 1-5' }]));

			// Checkpoint from 8:55 AM — 9:00 hasn't arrived yet
			const checkpoint = JSON.stringify({
				standup: new Date(2026, 1, 9, 8, 55, 0).toISOString(),
			});
			const result = await source.poll(checkpoint);
			expect(result.events).toHaveLength(0);
		});

		it('does not fire on weekend for weekday-only schedule', async () => {
			// Saturday 9:05 AM
			vi.setSystemTime(new Date(2026, 1, 7, 9, 5, 0));
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'standup', cron: '0 9 * * 1-5' }]));

			// Checkpoint from Saturday 8:55 AM
			const checkpoint = JSON.stringify({
				standup: new Date(2026, 1, 7, 8, 55, 0).toISOString(),
			});
			const result = await source.poll(checkpoint);
			expect(result.events).toHaveLength(0);
		});
	});

	// ─── Checkpoint round-trip ───────────────────────────────────────────────

	describe('checkpoint serialization', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('returns valid JSON checkpoint string', async () => {
			vi.setSystemTime(new Date(2026, 1, 9, 12, 0, 0));
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'test', cron: 'every 1m' }]));

			const result = await source.poll(null);
			expect(() => JSON.parse(result.checkpoint)).not.toThrow();
		});

		it('checkpoint contains schedule timestamps', async () => {
			vi.setSystemTime(new Date(2026, 1, 9, 12, 0, 0));
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'alpha', cron: 'every 1m' }]));

			const result = await source.poll(null);
			const cp = JSON.parse(result.checkpoint);
			expect(cp.alpha).toBeDefined();
			expect(new Date(cp.alpha).toISOString()).toBe(cp.alpha);
		});

		it('checkpoint preserves per-schedule timestamps independently', async () => {
			vi.setSystemTime(new Date(2026, 1, 9, 12, 0, 0));
			const source = new CronSource();
			await source.init(
				makeConfig([
					{ name: 'fast', cron: 'every 1m' },
					{ name: 'slow', cron: 'every 1h' },
				]),
			);

			// Both fire
			const first = await source.poll(null);
			const cp1 = JSON.parse(first.checkpoint);
			expect(cp1.fast).toBeDefined();
			expect(cp1.slow).toBeDefined();

			// Advance 2 minutes — only 'fast' fires
			vi.advanceTimersByTime(2 * 60_000);
			const second = await source.poll(first.checkpoint);
			const cp2 = JSON.parse(second.checkpoint);

			// 'fast' timestamp should be updated, 'slow' should be preserved
			expect(cp2.fast).not.toBe(cp1.fast);
			expect(cp2.slow).toBe(cp1.slow);
		});

		it('round-trips checkpoint through poll correctly', async () => {
			vi.setSystemTime(new Date(2026, 1, 9, 12, 0, 0));
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'test', cron: 'every 5m' }]));

			const first = await source.poll(null);
			expect(first.events).toHaveLength(1);

			// Immediate re-poll with same checkpoint — should not fire
			const second = await source.poll(first.checkpoint);
			expect(second.events).toHaveLength(0);

			// Advance past interval and poll again
			vi.advanceTimersByTime(6 * 60_000);
			const third = await source.poll(second.checkpoint);
			expect(third.events).toHaveLength(1);
		});
	});

	// ─── Full poll cycle (integration) ───────────────────────────────────────

	describe('full poll cycle', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('interval: init -> poll (fires) -> poll (too soon) -> poll (fires again)', async () => {
			vi.setSystemTime(new Date(2026, 1, 9, 12, 0, 0));
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'heartbeat', cron: 'every 5m' }]));

			// Step 1: First poll fires
			const poll1 = await source.poll(null);
			expect(poll1.events).toHaveLength(1);
			expect(poll1.events[0].payload.schedule).toBe('heartbeat');

			// Step 2: 3 minutes later — too soon
			vi.advanceTimersByTime(3 * 60_000);
			const poll2 = await source.poll(poll1.checkpoint);
			expect(poll2.events).toHaveLength(0);

			// Step 3: 3 more minutes later (6 total) — fires again
			vi.advanceTimersByTime(3 * 60_000);
			const poll3 = await source.poll(poll2.checkpoint);
			expect(poll3.events).toHaveLength(1);
			expect(poll3.events[0].payload.schedule).toBe('heartbeat');
		});

		it('cron: init -> poll (fires) -> poll (too soon) -> advance past next match -> poll (fires)', async () => {
			// Start at Monday 9:05 AM — just past the cron match
			vi.setSystemTime(new Date(2026, 1, 9, 9, 5, 0));
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'standup', cron: '0 9 * * 1-5' }]));

			// Step 1: First poll — fires because epoch checkpoint (1970) means 9:00 is in window
			const poll1 = await source.poll(null);
			expect(poll1.events).toHaveLength(1);

			// Step 2: 5 minutes later (9:10) — no new 9:00 has occurred
			vi.advanceTimersByTime(5 * 60_000);
			const poll2 = await source.poll(poll1.checkpoint);
			expect(poll2.events).toHaveLength(0);

			// Step 3: Advance to Tuesday 9:05 AM — next weekday 9:00 has passed
			vi.setSystemTime(new Date(2026, 1, 10, 9, 5, 0));
			const poll3 = await source.poll(poll2.checkpoint);
			expect(poll3.events).toHaveLength(1);
			expect(poll3.events[0].payload.schedule).toBe('standup');
		});

		it('multiple schedules with different intervals track independently', async () => {
			vi.setSystemTime(new Date(2026, 1, 9, 12, 0, 0));
			const source = new CronSource();
			await source.init(
				makeConfig([
					{ name: 'fast', cron: 'every 1m' },
					{ name: 'medium', cron: 'every 5m' },
					{ name: 'slow', cron: 'every 30m' },
				]),
			);

			// All fire on first poll
			const poll1 = await source.poll(null);
			expect(poll1.events).toHaveLength(3);

			// After 2 minutes: only 'fast' fires
			vi.advanceTimersByTime(2 * 60_000);
			const poll2 = await source.poll(poll1.checkpoint);
			expect(poll2.events).toHaveLength(1);
			expect(poll2.events[0].payload.schedule).toBe('fast');

			// After 5 more minutes (7 total): 'fast' and 'medium' fire
			vi.advanceTimersByTime(5 * 60_000);
			const poll3 = await source.poll(poll2.checkpoint);
			expect(poll3.events).toHaveLength(2);
			const schedules = poll3.events.map((e) => e.payload.schedule).sort();
			expect(schedules).toEqual(['fast', 'medium']);

			// After 25 more minutes (32 total): all three fire
			vi.advanceTimersByTime(25 * 60_000);
			const poll4 = await source.poll(poll3.checkpoint);
			expect(poll4.events).toHaveLength(3);
		});

		it('mixed interval and cron schedules work together', async () => {
			// Monday 8:55 AM
			vi.setSystemTime(new Date(2026, 1, 9, 8, 55, 0));
			const source = new CronSource();
			await source.init(
				makeConfig([
					{ name: 'heartbeat', cron: 'every 3m' },
					{ name: 'standup', cron: '0 9 * * 1-5' },
				]),
			);

			// First poll: heartbeat fires (epoch checkpoint), standup fires (epoch to 8:55 has matches)
			const poll1 = await source.poll(null);
			expect(poll1.events).toHaveLength(2);

			// Advance to 8:58 — heartbeat fires (3m elapsed), standup does not
			vi.advanceTimersByTime(3 * 60_000);
			const poll2 = await source.poll(poll1.checkpoint);
			expect(poll2.events).toHaveLength(1);
			expect(poll2.events[0].payload.schedule).toBe('heartbeat');

			// Advance to 9:01 — heartbeat fires (3m), standup fires (9:00 passed)
			vi.advanceTimersByTime(3 * 60_000);
			const poll3 = await source.poll(poll2.checkpoint);
			expect(poll3.events).toHaveLength(2);
			const names = poll3.events.map((e) => e.payload.schedule).sort();
			expect(names).toEqual(['heartbeat', 'standup']);
		});
	});

	// ─── Shutdown ────────────────────────────────────────────────────────────

	describe('shutdown', () => {
		it('resolves without error', async () => {
			const source = new CronSource();
			await source.init(makeConfig([{ name: 'test', cron: 'every 1m' }]));
			await expect(source.shutdown()).resolves.toBeUndefined();
		});
	});
});

// ─── Registration ────────────────────────────────────────────────────────────

describe('connector registration', () => {
	it('returns a valid registration with id "cron"', async () => {
		const mod = await import('../index.js');
		const reg = mod.default();
		expect(reg.id).toBe('cron');
	});

	it('provides a source class', async () => {
		const mod = await import('../index.js');
		const reg = mod.default();
		expect(reg.source).toBeDefined();
	});

	it('provides a configSchema', async () => {
		const mod = await import('../index.js');
		const reg = mod.default();
		expect(reg.configSchema).toBeDefined();
	});

	it('configSchema requires schedules array', async () => {
		const mod = await import('../index.js');
		const reg = mod.default();
		const schema = reg.configSchema as Record<string, unknown>;
		expect(schema.required).toContain('schedules');
	});

	it('provides setup metadata with empty env_vars', async () => {
		const mod = await import('../index.js');
		const reg = mod.default();
		expect(reg.setup).toBeDefined();
		expect(reg.setup?.env_vars).toEqual([]);
	});

	it('source class can be instantiated', async () => {
		const mod = await import('../index.js');
		const reg = mod.default();
		expect(reg.source).toBeDefined();
		const Source = reg.source as NonNullable<typeof reg.source>;
		const instance = new Source();
		expect(instance.id).toBe('cron');
	});
});
