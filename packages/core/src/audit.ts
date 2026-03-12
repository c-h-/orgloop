/**
 * AuditTrail — tracks every SOP execution with full provenance.
 *
 * Records input events, matched routes, agent sessions, outputs,
 * and content hashes for security observability.
 */

import { createHash } from 'node:crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single output/side-effect produced by an SOP execution. */
export interface AuditOutput {
	/** What kind of output (e.g., "message.sent", "issue.created", "pr.commented") */
	type: string;
	/** Target system or resource */
	target: string;
	/** SHA-256 hash of the output content */
	content_hash: string;
	/** Timestamp of the output */
	timestamp: string;
	/** Validation flags raised for this output */
	flags: AuditFlag[];
}

/** A flag raised during output validation. */
export interface AuditFlag {
	/** Flag type */
	type: 'instruction_content' | 'input_echo' | 'scope_violation' | 'chain_depth';
	/** Severity */
	severity: 'info' | 'warning' | 'critical';
	/** Human-readable description */
	message: string;
}

/** Complete audit record for one SOP execution. */
export interface AuditRecord {
	/** Unique audit record ID */
	id: string;
	/** ISO 8601 timestamp */
	timestamp: string;
	/** Trace ID linking the full event chain */
	trace_id: string;

	// Input
	/** Input event ID */
	input_event_id: string;
	/** Input event source */
	input_source: string;
	/** Input event type */
	input_type: string;
	/** SHA-256 hash of the input event payload */
	input_content_hash: string;

	// Routing
	/** Matched route name */
	route: string;
	/** SOP file path (if any) */
	sop_file: string | null;
	/** Module that processed the event */
	module: string;

	// Execution
	/** Actor that handled the event */
	actor: string;
	/** Delivery status */
	delivery_status: 'delivered' | 'rejected' | 'error' | 'held';
	/** Processing duration in ms */
	duration_ms: number;

	// Outputs
	/** All outputs/side-effects produced */
	outputs: AuditOutput[];

	// Chain tracking
	/** Depth of this event in its chain (1 = root) */
	chain_depth: number;
	/** Parent event ID (if this event was triggered by another SOP execution) */
	parent_event_id: string | null;

	// Validation
	/** Whether any outputs were held for review */
	held_for_review: boolean;
	/** All flags raised during validation */
	flags: AuditFlag[];
}

export interface AuditTrailOptions {
	/** Maximum number of audit records to retain (default: 5000) */
	maxSize?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let auditCounter = 0;

/** Generate a unique audit record ID. */
export function generateAuditId(): string {
	return `aud_${Date.now().toString(36)}_${(auditCounter++).toString(36)}`;
}

/** Compute SHA-256 hash of a JSON-serializable value. */
export function contentHash(value: unknown): string {
	const json = JSON.stringify(value, null, 0);
	return createHash('sha256').update(json).digest('hex');
}

// ─── AuditTrail Class ────────────────────────────────────────────────────────

export class AuditTrail {
	private readonly buffer: AuditRecord[];
	private readonly maxSize: number;
	private head = 0;
	private count = 0;

	constructor(options?: AuditTrailOptions) {
		this.maxSize = options?.maxSize ?? 5000;
		this.buffer = new Array<AuditRecord>(this.maxSize);
	}

	/** Record an audit entry. */
	record(entry: AuditRecord): void {
		this.buffer[this.head] = entry;
		this.head = (this.head + 1) % this.maxSize;
		if (this.count < this.maxSize) {
			this.count++;
		}
	}

	/** Get the number of stored records. */
	size(): number {
		return this.count;
	}

	/** Query audit records, newest first. */
	query(filter?: {
		trace_id?: string;
		route?: string;
		actor?: string;
		held_only?: boolean;
		flagged_only?: boolean;
		limit?: number;
	}): AuditRecord[] {
		let records = this.toArray();

		if (filter?.trace_id) {
			records = records.filter((r) => r.trace_id === filter.trace_id);
		}
		if (filter?.route) {
			records = records.filter((r) => r.route === filter.route);
		}
		if (filter?.actor) {
			records = records.filter((r) => r.actor === filter.actor);
		}
		if (filter?.held_only) {
			records = records.filter((r) => r.held_for_review);
		}
		if (filter?.flagged_only) {
			records = records.filter((r) => r.flags.length > 0);
		}
		if (filter?.limit && filter.limit > 0) {
			records = records.slice(0, filter.limit);
		}

		return records;
	}

	/** Get all records for a trace (the full event chain). */
	getChain(traceId: string): AuditRecord[] {
		return this.toArray().filter((r) => r.trace_id === traceId);
	}

	/** Return all records as an array, newest first. */
	private toArray(): AuditRecord[] {
		if (this.count === 0) return [];

		const result: AuditRecord[] = [];
		const start = (this.head - this.count + this.maxSize) % this.maxSize;

		for (let i = this.count - 1; i >= 0; i--) {
			const idx = (start + i) % this.maxSize;
			result.push(this.buffer[idx]);
		}

		return result;
	}
}
