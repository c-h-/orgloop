/**
 * Claude Code source connector — hook-based (webhook receiver).
 *
 * Instead of polling, this connector exposes a webhook handler that receives
 * POST requests from Claude Code's post-exit hook script.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type {
	OrgLoopEvent,
	PollResult,
	SourceConfig,
	SourceConnector,
	WebhookHandler,
} from '@orgloop/sdk';
import { buildEvent } from '@orgloop/sdk';

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

interface ClaudeCodeSessionPayload {
	session_id: string;
	working_directory?: string;
	/** Alias for working_directory (sent by Claude Code's stop hook) */
	cwd?: string;
	duration_seconds: number;
	exit_status: number;
	summary?: string;
	transcript_path?: string;
	timestamp?: string;
}

interface ClaudeCodeSourceConfig {
	secret?: string;
	buffer_dir?: string;
}

export class ClaudeCodeSource implements SourceConnector {
	readonly id = 'claude-code';
	private sourceId = 'claude-code';
	private secret?: string;
	private bufferPath?: string;
	private pendingEvents: OrgLoopEvent[] = [];

	async init(config: SourceConfig): Promise<void> {
		this.sourceId = config.id;
		const cfg = config.config as unknown as ClaudeCodeSourceConfig;

		if (cfg.secret) {
			this.secret = resolveEnvVar(cfg.secret);
		}

		if (cfg.buffer_dir) {
			const dir = resolveEnvVar(cfg.buffer_dir);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			this.bufferPath = join(dir, `claude-code-${this.sourceId}.jsonl`);
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
				const payload = JSON.parse(body) as ClaudeCodeSessionPayload;
				// Accept cwd as alias for working_directory (Claude Code stop hook sends cwd)
				const workingDirectory = payload.working_directory ?? payload.cwd ?? '';

				const event = buildEvent({
					source: this.sourceId,
					type: 'actor.stopped',
					provenance: {
						platform: 'claude-code',
						platform_event: 'session.exited',
						author: 'claude-code',
						author_type: 'bot',
						session_id: payload.session_id,
						working_directory: workingDirectory,
					},
					payload: {
						session_id: payload.session_id,
						working_directory: workingDirectory,
						duration_seconds: payload.duration_seconds,
						exit_status: payload.exit_status,
						summary: payload.summary ?? '',
						transcript_path: payload.transcript_path ?? '',
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
