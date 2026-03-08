/**
 * Coding agent source connector — harness-agnostic hook-based (webhook receiver).
 *
 * A generalized connector for any coding agent harness (Claude Code, Codex,
 * OpenCode, Pi, Pi-rust, etc.) that sends lifecycle events via webhooks.
 *
 * Instead of polling, this connector exposes a webhook handler that receives
 * POST requests from harness hook scripts (post-exit, pre-session, etc.).
 *
 * Emits normalized lifecycle events:
 *   - started → resource.changed (session launched)
 *   - completed → actor.stopped (exit_status 0)
 *   - failed → actor.stopped (exit_status non-zero)
 *   - stopped → actor.stopped (user/host interruption)
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type {
	LifecycleOutcome,
	LifecyclePhase,
	OrgLoopEvent,
	PollResult,
	SourceConfig,
	SourceConnector,
	WebhookHandler,
} from '@orgloop/sdk';
import { buildDedupeKey, buildEvent, eventTypeForPhase, TERMINAL_PHASES } from '@orgloop/sdk';

/** Resolve env var references like ${WEBHOOK_SECRET} */
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

export interface CodingAgentSessionPayload {
	session_id: string;
	working_directory?: string;
	/** Alias for working_directory (sent by some harness stop hooks) */
	cwd?: string;
	duration_seconds?: number;
	exit_status?: number;
	summary?: string;
	transcript_path?: string;
	timestamp?: string;
	/**
	 * Hook type: 'start' for session launch, 'stop' for session exit.
	 * Defaults to 'stop' for backward compatibility.
	 */
	hook_type?: 'start' | 'stop';
	/** Arbitrary metadata from the webhook sender, passed through to event payload. */
	meta?: Record<string, unknown>;
}

export interface CodingAgentSourceConfig {
	secret?: string;
	buffer_dir?: string;
	/** Platform identifier for provenance. Defaults to the source ID. */
	platform?: string;
	/** Harness identifier for session metadata. Defaults to platform value. */
	harness?: string;
}

/**
 * Map exit_status and hook context to lifecycle phase + outcome.
 */
function resolveLifecycle(payload: CodingAgentSessionPayload): {
	phase: LifecyclePhase;
	outcome?: LifecycleOutcome;
	reason?: string;
} {
	const hookType = payload.hook_type ?? 'stop';

	if (hookType === 'start') {
		return { phase: 'started' };
	}

	// Terminal: determine outcome from exit_status
	const exitStatus = payload.exit_status ?? 0;

	if (exitStatus === 0) {
		return { phase: 'completed', outcome: 'success', reason: 'exit_code_0' };
	}

	// Signals: 128 + signal number (e.g., 130 = SIGINT, 137 = SIGKILL, 143 = SIGTERM)
	if (exitStatus > 128) {
		const signal = exitStatus - 128;
		const signalNames: Record<number, string> = {
			2: 'sigint',
			9: 'sigkill',
			15: 'sigterm',
		};
		const signalName = signalNames[signal] ?? `signal_${signal}`;
		return { phase: 'stopped', outcome: 'cancelled', reason: signalName };
	}

	return { phase: 'failed', outcome: 'failure', reason: `exit_code_${exitStatus}` };
}

export class CodingAgentSource implements SourceConnector {
	readonly id = 'coding-agent';
	private sourceId = 'coding-agent';
	private platform = 'coding-agent';
	private harness = 'coding-agent';
	private secret?: string;
	private bufferPath?: string;
	private pendingEvents: OrgLoopEvent[] = [];

	async init(config: SourceConfig): Promise<void> {
		this.sourceId = config.id;
		const cfg = config.config as unknown as CodingAgentSourceConfig;

		// platform defaults to source id; harness defaults to platform
		this.platform = cfg.platform ?? config.id;
		this.harness = cfg.harness ?? this.platform;

		if (cfg.secret) {
			this.secret = resolveEnvVar(cfg.secret);
		}

		if (cfg.buffer_dir) {
			const dir = resolveEnvVar(cfg.buffer_dir);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			this.bufferPath = join(dir, `coding-agent-${this.sourceId}.jsonl`);
			this.loadBufferedEvents();
		}
	}

	async poll(_checkpoint: string | null): Promise<PollResult> {
		// Drain any events received via webhook since last poll
		let events: OrgLoopEvent[];
		if (this.bufferPath) {
			events = this.loadBufferedEvents();
			// Clear the buffer file
			writeFileSync(this.bufferPath, '');
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

			// HMAC validation if secret is configured
			if (this.secret) {
				const signature =
					(req.headers['x-hub-signature-256'] as string) ?? (req.headers['x-signature'] as string);
				if (!signature) {
					res.writeHead(401, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Missing signature' }));
					return [];
				}

				const expected = `sha256=${createHmac('sha256', this.secret).update(body).digest('hex')}`;
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
				const payload = JSON.parse(body) as CodingAgentSessionPayload;
				// Accept cwd as alias for working_directory
				const workingDirectory = payload.working_directory ?? payload.cwd ?? '';
				const sessionId = payload.session_id;
				const now = new Date().toISOString();

				// Resolve lifecycle phase + outcome
				const { phase, outcome, reason } = resolveLifecycle(payload);
				const terminal = TERMINAL_PHASES.has(phase);

				const event = buildEvent({
					source: this.sourceId,
					type: eventTypeForPhase(phase),
					provenance: {
						platform: this.platform,
						platform_event: `session.${phase}`,
						author: this.platform,
						author_type: 'bot',
						session_id: sessionId,
						working_directory: workingDirectory,
					},
					payload: {
						// Normalized lifecycle contract
						lifecycle: {
							phase,
							terminal,
							...(terminal && outcome ? { outcome } : {}),
							...(reason ? { reason } : {}),
							dedupe_key: buildDedupeKey(this.platform, sessionId, phase),
						},
						session: {
							id: sessionId,
							adapter: this.platform,
							harness: this.harness,
							cwd: workingDirectory || undefined,
							started_at: terminal ? undefined : now,
							...(terminal
								? {
										ended_at: now,
										exit_status: payload.exit_status ?? 0,
									}
								: {}),
							...(payload.meta ? { meta: payload.meta } : {}),
						},
						// Backward-compatible fields
						session_id: sessionId,
						working_directory: workingDirectory,
						duration_seconds: payload.duration_seconds ?? 0,
						exit_status: payload.exit_status ?? 0,
						summary: payload.summary ?? '',
						transcript_path: payload.transcript_path ?? '',
						...(payload.meta ? { meta: payload.meta } : {}),
					},
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
		if (this.bufferPath) {
			appendFileSync(this.bufferPath, `${JSON.stringify(event)}\n`);
		} else {
			this.pendingEvents.push(event);
		}
	}

	private loadBufferedEvents(): OrgLoopEvent[] {
		if (!this.bufferPath || !existsSync(this.bufferPath)) {
			return [];
		}
		const content = readFileSync(this.bufferPath, 'utf-8').trim();
		if (!content) {
			return [];
		}
		return content.split('\n').map((line) => JSON.parse(line) as OrgLoopEvent);
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
