/**
 * LoopDetector — event chain tracking and circuit breaker.
 *
 * Tracks event chains: if Event A → SOP → Output B → Event C → SOP → Output D,
 * flags chain length and triggers circuit breaker when loops are detected.
 *
 * Defense against the Viral Agent Loop (arXiv:2602.19555).
 */

import type { AuditFlag } from './audit.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A node in the event chain. */
export interface ChainNode {
	/** Event ID */
	event_id: string;
	/** Source that emitted this event */
	source: string;
	/** Event type */
	type: string;
	/** Route that matched (if any) */
	route: string | null;
	/** Actor that handled (if any) */
	actor: string | null;
	/** Depth in the chain (1 = root event) */
	depth: number;
	/** ISO 8601 timestamp */
	timestamp: string;
}

/** Result of a loop detection check. */
export interface LoopCheckResult {
	/** Whether a loop was detected */
	loop_detected: boolean;
	/** Whether the circuit breaker tripped */
	circuit_broken: boolean;
	/** Current chain depth */
	chain_depth: number;
	/** The full chain for this trace */
	chain: ChainNode[];
	/** Flags raised */
	flags: AuditFlag[];
}

export interface LoopDetectorOptions {
	/** Maximum chain depth before alerting (default: 3) */
	maxChainDepth?: number;
	/** Maximum chain depth before circuit breaking (default: 5) */
	circuitBreakerDepth?: number;
	/** Time window in ms for chain tracking (default: 300000 = 5 minutes) */
	windowMs?: number;
	/** Maximum number of traces to track simultaneously (default: 10000) */
	maxTraces?: number;
}

// ─── LoopDetector Class ──────────────────────────────────────────────────────

export class LoopDetector {
	private readonly chains = new Map<string, ChainNode[]>();
	private readonly maxChainDepth: number;
	private readonly circuitBreakerDepth: number;
	private readonly windowMs: number;
	private readonly maxTraces: number;

	/** Traces that have been circuit-broken (trace_id → timestamp). */
	private readonly brokenCircuits = new Map<string, number>();

	constructor(options?: LoopDetectorOptions) {
		this.maxChainDepth = options?.maxChainDepth ?? 3;
		this.circuitBreakerDepth = options?.circuitBreakerDepth ?? 5;
		this.windowMs = options?.windowMs ?? 300_000;
		this.maxTraces = options?.maxTraces ?? 10_000;
	}

	/**
	 * Record an event in its chain and check for loops.
	 *
	 * Call this before processing each event. If the result has
	 * circuit_broken=true, the event should NOT be processed.
	 */
	check(
		traceId: string,
		eventId: string,
		source: string,
		type: string,
		route: string | null,
		actor: string | null,
	): LoopCheckResult {
		this.cleanup();

		// Check if this trace is already circuit-broken
		if (this.brokenCircuits.has(traceId)) {
			return {
				loop_detected: true,
				circuit_broken: true,
				chain_depth: this.getChainDepth(traceId) + 1,
				chain: this.chains.get(traceId) ?? [],
				flags: [
					{
						type: 'chain_depth',
						severity: 'critical',
						message: `Circuit broken for trace ${traceId} — event chain exceeded maximum depth`,
					},
				],
			};
		}

		// Get or create chain
		let chain = this.chains.get(traceId);
		if (!chain) {
			chain = [];
			this.chains.set(traceId, chain);
		}

		const depth = chain.length + 1;

		// Add node
		const node: ChainNode = {
			event_id: eventId,
			source,
			type,
			route,
			actor,
			depth,
			timestamp: new Date().toISOString(),
		};
		chain.push(node);

		// Check for pattern loops (same source+type appearing multiple times)
		const patternKey = `${source}:${type}`;
		const patternCount = chain.filter((n) => `${n.source}:${n.type}` === patternKey).length;
		const patternLoop = patternCount >= 2;

		// Build flags
		const flags: AuditFlag[] = [];

		if (depth > this.maxChainDepth) {
			flags.push({
				type: 'chain_depth',
				severity: depth >= this.circuitBreakerDepth ? 'critical' : 'warning',
				message: `Event chain depth ${depth} exceeds threshold ${this.maxChainDepth} (trace: ${traceId})`,
			});
		}

		if (patternLoop) {
			flags.push({
				type: 'chain_depth',
				severity: 'warning',
				message: `Repeated event pattern "${patternKey}" detected ${patternCount} times in chain (trace: ${traceId})`,
			});
		}

		// Circuit breaker
		const shouldBreak = depth >= this.circuitBreakerDepth;
		if (shouldBreak) {
			this.brokenCircuits.set(traceId, Date.now());
		}

		return {
			loop_detected: patternLoop || depth > this.maxChainDepth,
			circuit_broken: shouldBreak,
			chain_depth: depth,
			chain: [...chain],
			flags,
		};
	}

	/** Get the current chain depth for a trace. */
	getChainDepth(traceId: string): number {
		return this.chains.get(traceId)?.length ?? 0;
	}

	/** Get the full chain for a trace. */
	getChain(traceId: string): ChainNode[] {
		return [...(this.chains.get(traceId) ?? [])];
	}

	/** Check if a trace has been circuit-broken. */
	isCircuitBroken(traceId: string): boolean {
		return this.brokenCircuits.has(traceId);
	}

	/** Reset a circuit breaker for a trace (manual override). */
	resetCircuit(traceId: string): void {
		this.brokenCircuits.delete(traceId);
	}

	/** Number of active traces being tracked. */
	activeTraces(): number {
		return this.chains.size;
	}

	/** Number of broken circuits. */
	brokenCircuitCount(): number {
		return this.brokenCircuits.size;
	}

	/** Clean up expired traces and evict oldest if over limit. */
	private cleanup(): void {
		const now = Date.now();
		const cutoff = now - this.windowMs;

		// Remove expired chains
		for (const [traceId, chain] of this.chains) {
			if (chain.length === 0) {
				this.chains.delete(traceId);
				continue;
			}
			const lastTimestamp = new Date(chain[chain.length - 1].timestamp).getTime();
			if (lastTimestamp < cutoff) {
				this.chains.delete(traceId);
			}
		}

		// Remove expired broken circuits
		for (const [traceId, timestamp] of this.brokenCircuits) {
			if (timestamp < cutoff) {
				this.brokenCircuits.delete(traceId);
			}
		}

		// Evict oldest traces if over limit
		if (this.chains.size > this.maxTraces) {
			const entries = [...this.chains.entries()].sort((a, b) => {
				const aTime = a[1].length > 0 ? new Date(a[1][a[1].length - 1].timestamp).getTime() : 0;
				const bTime = b[1].length > 0 ? new Date(b[1][b[1].length - 1].timestamp).getTime() : 0;
				return aTime - bTime;
			});

			const toRemove = entries.slice(0, entries.length - this.maxTraces);
			for (const [traceId] of toRemove) {
				this.chains.delete(traceId);
			}
		}
	}
}
