/**
 * Cron source connector — emits events on time-based schedules.
 *
 * Supports standard 5-field cron expressions (minute hour dom month dow)
 * and interval-based schedules (e.g., "every 5m", "every 1h", "every 30s").
 *
 * Cron matching is poll-based: on each poll(), the connector checks whether
 * any scheduled cron time has passed since the last checkpoint.
 */

import type { OrgLoopEvent, PollResult, SourceConfig, SourceConnector } from '@orgloop/sdk';
import { buildEvent, parseDuration } from '@orgloop/sdk';

/** A single schedule definition from config */
export interface CronSchedule {
	name: string;
	cron: string;
	payload?: Record<string, unknown>;
}

/** Cron connector config shape */
export interface CronSourceConfig {
	schedules: CronSchedule[];
}

/** Parsed checkpoint: last trigger time per schedule name */
interface CronCheckpoint {
	[scheduleName: string]: string; // ISO 8601 timestamp
}

// ─── Interval-based schedules ─────────────────────────────────────────────────

/**
 * Parse an interval expression like "every 5m" or "every 30s" into milliseconds.
 * Falls back to parseDuration for bare duration strings like "5m".
 */
export function parseInterval(expr: string): number {
	const everyMatch = expr.match(/^every\s+(.+)$/i);
	const durationStr = everyMatch ? everyMatch[1].trim() : expr;
	return parseDuration(durationStr);
}

// ─── Cron expression parsing ──────────────────────────────────────────────────

/** Parsed representation of a 5-field cron expression */
export interface CronFields {
	minutes: Set<number>;
	hours: Set<number>;
	daysOfMonth: Set<number>;
	months: Set<number>;
	daysOfWeek: Set<number>;
}

/**
 * Parse a single cron field into a set of valid values.
 *
 * Supports: *, specific values, ranges (1-5), steps (star/N, range/N),
 * and comma-separated lists.
 */
export function parseCronField(field: string, min: number, max: number): Set<number> {
	const values = new Set<number>();

	for (const part of field.split(',')) {
		const trimmed = part.trim();

		// */N — step from min
		const starStep = trimmed.match(/^\*\/(\d+)$/);
		if (starStep) {
			const step = Number.parseInt(starStep[1], 10);
			if (step <= 0) throw new Error(`Invalid step value: ${step}`);
			for (let i = min; i <= max; i += step) {
				values.add(i);
			}
			continue;
		}

		// * — all values
		if (trimmed === '*') {
			for (let i = min; i <= max; i++) {
				values.add(i);
			}
			continue;
		}

		// N-M/S — range with step
		const rangeStep = trimmed.match(/^(\d+)-(\d+)\/(\d+)$/);
		if (rangeStep) {
			const start = Number.parseInt(rangeStep[1], 10);
			const end = Number.parseInt(rangeStep[2], 10);
			const step = Number.parseInt(rangeStep[3], 10);
			if (start < min || end > max || step <= 0) {
				throw new Error(`Invalid range/step: ${trimmed} (valid: ${min}-${max})`);
			}
			for (let i = start; i <= end; i += step) {
				values.add(i);
			}
			continue;
		}

		// N-M — range
		const range = trimmed.match(/^(\d+)-(\d+)$/);
		if (range) {
			const start = Number.parseInt(range[1], 10);
			const end = Number.parseInt(range[2], 10);
			if (start < min || end > max) {
				throw new Error(`Range out of bounds: ${trimmed} (valid: ${min}-${max})`);
			}
			for (let i = start; i <= end; i++) {
				values.add(i);
			}
			continue;
		}

		// N — single value
		const num = Number.parseInt(trimmed, 10);
		if (Number.isNaN(num) || num < min || num > max) {
			throw new Error(`Invalid value: ${trimmed} (valid: ${min}-${max})`);
		}
		values.add(num);
	}

	return values;
}

/**
 * Parse a 5-field cron expression into structured field sets.
 *
 * Format: minute hour day-of-month month day-of-week
 * - minute: 0-59
 * - hour: 0-23
 * - day-of-month: 1-31
 * - month: 1-12
 * - day-of-week: 0-6 (0 = Sunday)
 */
export function parseCronExpression(expr: string): CronFields {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error(
			`Invalid cron expression: "${expr}". Expected 5 fields (minute hour dom month dow).`,
		);
	}

	return {
		minutes: parseCronField(fields[0], 0, 59),
		hours: parseCronField(fields[1], 0, 23),
		daysOfMonth: parseCronField(fields[2], 1, 31),
		months: parseCronField(fields[3], 1, 12),
		daysOfWeek: parseCronField(fields[4], 0, 6),
	};
}

/**
 * Check whether a given Date matches a parsed cron expression.
 */
export function cronMatchesDate(fields: CronFields, date: Date): boolean {
	return (
		fields.minutes.has(date.getMinutes()) &&
		fields.hours.has(date.getHours()) &&
		fields.daysOfMonth.has(date.getDate()) &&
		fields.months.has(date.getMonth() + 1) &&
		fields.daysOfWeek.has(date.getDay())
	);
}

/**
 * Find the most recent minute-aligned time in [after, before] that matches
 * the cron expression. Returns null if no match exists in the range.
 *
 * Scans backwards from `before` in 1-minute steps. The scan is bounded
 * to avoid infinite loops — at most 527040 minutes (366 days).
 */
export function findLastMatch(fields: CronFields, after: Date, before: Date): Date | null {
	// Align `before` down to the start of its minute
	const end = new Date(before);
	end.setSeconds(0, 0);

	// Align `after` up to the start of the next minute (exclusive lower bound)
	const start = new Date(after);
	if (start.getSeconds() > 0 || start.getMilliseconds() > 0) {
		start.setMinutes(start.getMinutes() + 1);
		start.setSeconds(0, 0);
	}

	// Max scan: 366 days in minutes
	const maxIterations = 366 * 24 * 60;
	const cursor = new Date(end);
	for (let i = 0; i < maxIterations && cursor >= start; i++) {
		if (cronMatchesDate(fields, cursor)) {
			return cursor;
		}
		cursor.setMinutes(cursor.getMinutes() - 1);
	}

	return null;
}

// ─── Internal schedule representation ─────────────────────────────────────────

/** A schedule resolved to either cron fields or a fixed interval */
type ResolvedSchedule =
	| {
			name: string;
			kind: 'cron';
			fields: CronFields;
			payload: Record<string, unknown>;
	  }
	| {
			name: string;
			kind: 'interval';
			interval_ms: number;
			payload: Record<string, unknown>;
	  };

/**
 * Determine whether a cron string is an interval format ("every Xm", bare "5m")
 * or a 5-field cron expression, and resolve it.
 */
function resolveSchedule(schedule: CronSchedule): ResolvedSchedule {
	const { name, cron, payload } = schedule;
	const p = payload ?? {};

	// "every ..." format
	if (/^every\s+/i.test(cron)) {
		return { name, kind: 'interval', interval_ms: parseInterval(cron), payload: p };
	}

	// Bare duration (e.g., "5m", "1h")
	if (/^\d+\w+$/.test(cron)) {
		return { name, kind: 'interval', interval_ms: parseInterval(cron), payload: p };
	}

	// 5-field cron expression
	const fields = parseCronExpression(cron);
	return { name, kind: 'cron', fields, payload: p };
}

// ─── Source connector ─────────────────────────────────────────────────────────

export class CronSource implements SourceConnector {
	readonly id = 'cron';
	private schedules: ResolvedSchedule[] = [];
	private sourceId = '';

	async init(config: SourceConfig): Promise<void> {
		this.sourceId = config.id;
		const cfg = config.config as unknown as CronSourceConfig;

		if (!cfg.schedules || !Array.isArray(cfg.schedules) || cfg.schedules.length === 0) {
			throw new Error('Cron connector requires at least one schedule');
		}

		this.schedules = cfg.schedules.map(resolveSchedule);
	}

	async poll(checkpoint: string | null): Promise<PollResult> {
		const now = new Date();
		const nowIso = now.toISOString();
		const state: CronCheckpoint = checkpoint ? JSON.parse(checkpoint) : {};
		const events: OrgLoopEvent[] = [];

		for (const schedule of this.schedules) {
			const lastTriggerIso = state[schedule.name];
			const lastTrigger = lastTriggerIso ? new Date(lastTriggerIso) : new Date(0);

			let shouldFire = false;

			if (schedule.kind === 'interval') {
				const elapsed = now.getTime() - lastTrigger.getTime();
				shouldFire = elapsed >= schedule.interval_ms;
			} else {
				// Cron: check if any matching minute exists between lastTrigger and now
				const match = findLastMatch(schedule.fields, lastTrigger, now);
				shouldFire = match !== null;
			}

			if (shouldFire) {
				const payloadExtra: Record<string, unknown> =
					schedule.kind === 'interval' ? { interval_ms: schedule.interval_ms } : {};

				events.push(
					buildEvent({
						source: this.sourceId,
						type: 'resource.changed',
						provenance: {
							platform: 'cron',
							platform_event: `schedule.${schedule.name}`,
							author_type: 'system',
						},
						payload: {
							schedule: schedule.name,
							...payloadExtra,
							...schedule.payload,
						},
					}),
				);
				state[schedule.name] = nowIso;
			}
		}

		return {
			events,
			checkpoint: JSON.stringify(state),
		};
	}

	async shutdown(): Promise<void> {
		// Nothing to clean up
	}
}
