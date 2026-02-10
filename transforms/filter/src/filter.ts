/**
 * Filter transform — the workhorse event filter for OrgLoop.
 *
 * Two modes:
 * 1. Match/exclude mode: built-in dot-path field matching
 * 2. jq mode: pipe event through jq subprocess
 *
 * Match modes:
 * - match:     AND — all criteria must match (keep if all match)
 * - match_any: OR  — any criterion can match (keep if any matches)
 * - exclude:   OR  — any criterion drops the event
 */

import { spawn } from 'node:child_process';
import type { OrgLoopEvent, Transform, TransformContext } from '@orgloop/sdk';
import { matchesAll, matchesAny } from './matcher.js';

interface FilterConfig {
	match?: Record<string, unknown>;
	match_any?: Record<string, unknown>;
	exclude?: Record<string, unknown>;
	jq?: string;
}

/**
 * Expand comma-separated string values into arrays for matching.
 * "alice,bob" → ["alice", "bob"]. Already-array values pass through.
 * Only applies to criterion values, not field paths.
 */
function expandCsvValues(criteria: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(criteria)) {
		if (typeof value === 'string' && value.includes(',')) {
			result[key] = value.split(',').map((s) => s.trim());
		} else {
			result[key] = value;
		}
	}
	return result;
}

export class FilterTransform implements Transform {
	readonly id = 'filter';
	private config: FilterConfig = {};

	async init(config: Record<string, unknown>): Promise<void> {
		const raw = config as FilterConfig;
		this.config = {
			match: raw.match ? expandCsvValues(raw.match) : undefined,
			match_any: raw.match_any ? expandCsvValues(raw.match_any) : undefined,
			exclude: raw.exclude ? expandCsvValues(raw.exclude) : undefined,
			jq: raw.jq,
		};
	}

	async execute(event: OrgLoopEvent, _context: TransformContext): Promise<OrgLoopEvent | null> {
		// jq mode takes precedence if specified
		if (this.config.jq) {
			return this.executeJq(event);
		}

		return this.executeMatchExclude(event);
	}

	async shutdown(): Promise<void> {
		// No resources to clean up
	}

	private executeMatchExclude(event: OrgLoopEvent): OrgLoopEvent | null {
		const eventObj = event as unknown as Record<string, unknown>;

		// Check exclude first — if any exclude criterion matches, drop
		if (this.config.exclude) {
			if (matchesAny(eventObj, this.config.exclude)) {
				return null;
			}
		}

		// Check match — all criteria must match (AND)
		if (this.config.match) {
			if (!matchesAll(eventObj, this.config.match)) {
				return null;
			}
		}

		// Check match_any — at least one criterion must match (OR)
		if (this.config.match_any) {
			if (!matchesAny(eventObj, this.config.match_any)) {
				return null;
			}
		}

		return event;
	}

	private executeJq(event: OrgLoopEvent): Promise<OrgLoopEvent | null> {
		return new Promise((resolve) => {
			try {
				const input = JSON.stringify(event);
				const jqExpr = this.config.jq ?? '';
				const proc = spawn('jq', ['-e', jqExpr], {
					stdio: ['pipe', 'pipe', 'pipe'],
					timeout: 5000,
				});

				let stdout = '';
				proc.stdout.on('data', (chunk: Buffer) => {
					stdout += chunk.toString();
				});

				proc.on('error', () => {
					resolve(null);
				});

				proc.on('close', (code) => {
					if (code !== 0) {
						resolve(null);
						return;
					}

					const trimmed = stdout.trim();
					if (!trimmed || trimmed === 'null' || trimmed === 'false') {
						resolve(null);
						return;
					}

					// If jq returned a modified object, try to parse it
					try {
						const result = JSON.parse(trimmed);
						if (typeof result === 'object' && result !== null && result.id) {
							resolve(result as OrgLoopEvent);
							return;
						}
					} catch {
						// Non-JSON truthy output means pass through
					}

					resolve(event);
				});

				proc.stdin.write(input);
				proc.stdin.end();
			} catch {
				resolve(null);
			}
		});
	}
}
