/**
 * Dedup transform — deduplicates events within a configurable time window.
 *
 * Builds a hash from specified key fields and drops events that have
 * been seen within the configured window.
 *
 * Config accepts both `key` and `fields` for the dedup key paths.
 * Using `fields` is equivalent to `key` — if both are provided, `key` wins.
 */

import { createHash } from 'node:crypto';
import type { OrgLoopEvent, Transform, TransformContext } from '@orgloop/sdk';
import { parseDuration } from '@orgloop/sdk';

interface DedupConfig {
	key: string[];
	window: string;
	store?: 'memory';
}

/** Config as it may arrive from YAML — supports both `key` and `fields` */
interface DedupRawConfig {
	key?: string[];
	fields?: string[];
	window?: string;
	store?: 'memory';
}

/** Known config properties for validation */
const KNOWN_CONFIG_KEYS = new Set(['key', 'fields', 'window', 'store']);

/**
 * Get a value from a nested object using a dot-separated path.
 */
function getByPath(obj: unknown, path: string): unknown {
	const segments = path.split('.');
	let current: unknown = obj;
	for (const segment of segments) {
		if (current === null || current === undefined || typeof current !== 'object') {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

export class DedupTransform implements Transform {
	readonly id = 'dedup';
	private config: DedupConfig = { key: [], window: '5m' };
	private windowMs = 5 * 60 * 1000;
	private seen = new Map<string, number>();
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	async init(config: Record<string, unknown>): Promise<void> {
		// Validate config keys — warn on unknown properties to catch typos early
		const unknownKeys = Object.keys(config).filter((k) => !KNOWN_CONFIG_KEYS.has(k));
		if (unknownKeys.length > 0) {
			throw new Error(
				`Dedup transform: unknown config keys: ${unknownKeys.join(', ')}. ` +
					`Valid keys are: ${[...KNOWN_CONFIG_KEYS].join(', ')}`,
			);
		}

		const c = config as unknown as DedupRawConfig;

		// Accept both `key` and `fields` — `key` takes precedence for backward compat
		const keyPaths = c.key ?? c.fields ?? ['source', 'type', 'id'];

		this.config = {
			key: keyPaths,
			window: c.window ?? '5m',
		};
		this.windowMs = parseDuration(this.config.window);

		// Clean up expired entries every window period (minimum 10s)
		const cleanupInterval = Math.max(this.windowMs, 10_000);
		this.cleanupTimer = setInterval(() => this.cleanup(), cleanupInterval);
		// Allow the process to exit even if cleanup timer is pending
		if (this.cleanupTimer.unref) {
			this.cleanupTimer.unref();
		}
	}

	async execute(event: OrgLoopEvent, _context: TransformContext): Promise<OrgLoopEvent | null> {
		const hash = this.buildHash(event);
		const now = Date.now();
		const lastSeen = this.seen.get(hash);

		if (lastSeen !== undefined && now - lastSeen < this.windowMs) {
			// Duplicate within window — drop
			return null;
		}

		// New or expired — pass and record
		this.seen.set(hash, now);
		return event;
	}

	async shutdown(): Promise<void> {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
		this.seen.clear();
	}

	private buildHash(event: OrgLoopEvent): string {
		const eventObj = event as unknown as Record<string, unknown>;
		const parts: string[] = [];

		for (const keyPath of this.config.key) {
			const value = getByPath(eventObj, keyPath);
			parts.push(String(value ?? ''));
		}

		const joined = parts.join('\0');
		return createHash('sha256').update(joined).digest('hex');
	}

	private cleanup(): void {
		const now = Date.now();
		for (const [hash, timestamp] of this.seen) {
			if (now - timestamp >= this.windowMs) {
				this.seen.delete(hash);
			}
		}
	}
}
