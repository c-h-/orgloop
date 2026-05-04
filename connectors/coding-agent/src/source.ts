/**
 * Coding agent source connector — harness-agnostic webhook receiver.
 *
 * One connector handles every coding-agent harness (claude-code, codex,
 * opencode, pi, pi-rust) by selecting a HarnessProfile at init time.
 * The profile drives signature header, HMAC algorithm, and payload
 * normalization. Setup metadata (env-var names, integrations) is owned
 * by the CLI's PLUGIN_CATALOG.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
	OrgLoopEvent,
	PollResult,
	SourceConfig,
	SourceConnector,
	WebhookHandler,
} from '@orgloop/sdk';
import { EventBuffer, parseBufferSize } from '@orgloop/sdk';
import {
	getHarnessProfile,
	HARNESS_PROFILES,
	type HarnessName,
	type HarnessProfile,
} from './harness-profiles/index.js';

function isKnownHarness(value: string | undefined): value is HarnessName {
	return value !== undefined && Object.hasOwn(HARNESS_PROFILES, value);
}

function resolveEnvVar(value: string): string {
	const match = value.match(/^\$\{(.+)\}$/);
	if (match) {
		const envValue = process.env[match[1]];
		if (!envValue) {
			throw new Error(`Environment variable ${match[1]} is not set`);
		}
		return envValue;
	}
	return value;
}

export interface CodingAgentSourceConfig {
	/** Harness identifier — selects the runtime profile (required when more than one profile is registered). */
	harness?: HarnessName;
	secret?: string;
	buffer_dir?: string;
	max_buffer_size?: string;
	/** Override platform identifier for provenance. Defaults to harness name. */
	platform?: string;
}

export class CodingAgentSource implements SourceConnector {
	readonly id = 'coding-agent';
	private sourceId = 'coding-agent';
	private profile: HarnessProfile | null = null;
	private platformOverride?: string;
	private secret?: string;
	private buffer?: EventBuffer;
	private pendingEvents: OrgLoopEvent[] = [];

	async init(config: SourceConfig): Promise<void> {
		this.sourceId = config.id;
		const cfg = config.config as unknown as CodingAgentSourceConfig;

		// Resolution order for the runtime profile:
		//   1. explicit `harness` config field (canonical, post-P4)
		//   2. `platform` field if it matches a known harness (legacy
		//      generalized-connector configs that pre-date the harness split)
		//   3. fall back to the source id if it matches a known harness
		//   4. default to claude-code (preserves the original alias behavior)
		const harnessName: HarnessName =
			cfg.harness ??
			(isKnownHarness(cfg.platform) ? cfg.platform : undefined) ??
			(isKnownHarness(this.sourceId) ? (this.sourceId as HarnessName) : undefined) ??
			'claude-code';
		this.profile = getHarnessProfile(harnessName);
		// Carry the user's explicit platform override into normalization so
		// generalized configs that set `platform` without `harness` keep
		// their existing provenance.
		this.platformOverride = cfg.platform;

		if (cfg.secret) {
			this.secret = resolveEnvVar(cfg.secret);
		}

		if (cfg.buffer_dir) {
			const dir = resolveEnvVar(cfg.buffer_dir);
			// Buffer file prefix stays 'coding-agent' so already-buffered events
			// from the previous (per-harness) connector layout — written as
			// coding-agent-<sourceId>.jsonl — continue to be drained after the
			// P4 consolidation upgrade.
			this.buffer = new EventBuffer({
				bufferDir: dir,
				filePrefix: 'coding-agent',
				sourceId: this.sourceId,
				maxBufferBytes: cfg.max_buffer_size ? parseBufferSize(cfg.max_buffer_size) : undefined,
			});
			this.buffer.ensureDir();
		}
	}

	async poll(_checkpoint: string | null): Promise<PollResult> {
		let events: OrgLoopEvent[];
		if (this.buffer) {
			events = this.buffer.drainSync();
		} else {
			events = [...this.pendingEvents];
			this.pendingEvents = [];
		}
		const checkpoint =
			events.length > 0 ? events[events.length - 1].timestamp : new Date().toISOString();
		return { events, checkpoint };
	}

	webhook(): WebhookHandler {
		return async (req: IncomingMessage, res: ServerResponse): Promise<OrgLoopEvent[]> => {
			if (req.method !== 'POST') {
				res.writeHead(405, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Method not allowed' }));
				return [];
			}

			const body = await readBody(req);
			const profile = this.profile;
			if (!profile) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'connector not initialised' }));
				return [];
			}

			if (this.secret) {
				const signature =
					(req.headers[profile.signatureHeader] as string) ??
					(req.headers['x-signature'] as string);
				if (!signature) {
					res.writeHead(401, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Missing signature' }));
					return [];
				}
				const expected = `${profile.hmacAlgorithm}=${createHmac(profile.hmacAlgorithm, this.secret).update(body).digest('hex')}`;
				const sigBuffer = Buffer.from(signature);
				const expectedBuffer = Buffer.from(expected);
				if (
					sigBuffer.length !== expectedBuffer.length ||
					!timingSafeEqual(sigBuffer, expectedBuffer)
				) {
					res.writeHead(401, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Invalid signature' }));
					return [];
				}
			}

			try {
				const raw = JSON.parse(body);
				const event = profile.normalizePayload(raw, {
					sourceId: this.sourceId,
					platformOverride: this.platformOverride,
				});
				this.persistEvent(event);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: true, event_id: event.id }));
				return [event];
			} catch {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
				return [];
			}
		};
	}

	async shutdown(): Promise<void> {
		this.pendingEvents = [];
	}

	private persistEvent(event: OrgLoopEvent): void {
		if (this.buffer) {
			this.buffer.append(event);
			this.buffer.enforceSize();
		} else {
			this.pendingEvents.push(event);
		}
	}
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
		req.on('error', reject);
	});
}
