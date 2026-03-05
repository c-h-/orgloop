/**
 * EventHistory — in-memory ring buffer for recent event records.
 *
 * Stores processed events with routing metadata for the REST API.
 * Configurable max size (default 1000). Oldest entries evicted on overflow.
 */

export interface EventRecord {
	/** Event ID */
	event_id: string;
	/** ISO 8601 timestamp */
	timestamp: string;
	/** Source connector ID */
	source: string;
	/** Event type (resource.changed, actor.stopped, message.received) */
	type: string;
	/** Route(s) that matched this event */
	matched_routes: string[];
	/** SOP file paths for matched routes */
	sop_files: string[];
	/** Actor IDs delivered to */
	actors: string[];
	/** Processing time in milliseconds */
	processing_ms: number;
	/** Module that processed this event */
	module: string;
	/** Trace ID */
	trace_id?: string;
}

export interface EventHistoryOptions {
	/** Maximum number of events to retain (default: 1000) */
	maxSize?: number;
}

export interface EventHistoryQuery {
	/** ISO 8601 start timestamp */
	from?: string;
	/** ISO 8601 end timestamp */
	to?: string;
	/** Filter by source connector ID */
	source?: string;
	/** Filter by matched route name */
	route?: string;
	/** Maximum number of results to return */
	limit?: number;
}

export class EventHistory {
	private readonly buffer: EventRecord[];
	private readonly maxSize: number;
	private head = 0;
	private count = 0;

	constructor(options?: EventHistoryOptions) {
		this.maxSize = options?.maxSize ?? 1000;
		this.buffer = new Array<EventRecord>(this.maxSize);
	}

	/** Add an event record to the ring buffer. */
	push(record: EventRecord): void {
		this.buffer[this.head] = record;
		this.head = (this.head + 1) % this.maxSize;
		if (this.count < this.maxSize) {
			this.count++;
		}
	}

	/** Get the current number of stored records. */
	size(): number {
		return this.count;
	}

	/** Query events with optional filters. Returns newest-first. */
	query(q?: EventHistoryQuery): EventRecord[] {
		const records = this.toArray();

		let filtered = records;

		if (q?.from) {
			const fromTime = new Date(q.from).getTime();
			filtered = filtered.filter((r) => new Date(r.timestamp).getTime() >= fromTime);
		}

		if (q?.to) {
			const toTime = new Date(q.to).getTime();
			filtered = filtered.filter((r) => new Date(r.timestamp).getTime() <= toTime);
		}

		if (q?.source) {
			filtered = filtered.filter((r) => r.source === q.source);
		}

		if (q?.route) {
			const routeFilter = q.route;
			filtered = filtered.filter((r) => r.matched_routes.includes(routeFilter));
		}

		if (q?.limit && q.limit > 0) {
			filtered = filtered.slice(0, q.limit);
		}

		return filtered;
	}

	/** Return all records as an array, newest first. */
	private toArray(): EventRecord[] {
		if (this.count === 0) return [];

		const result: EventRecord[] = [];
		const start = (this.head - this.count + this.maxSize) % this.maxSize;

		for (let i = this.count - 1; i >= 0; i--) {
			const idx = (start + i) % this.maxSize;
			result.push(this.buffer[idx]);
		}

		return result;
	}
}
