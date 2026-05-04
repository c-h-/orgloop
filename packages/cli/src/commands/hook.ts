/**
 * orgloop hook — Forward hook events to a running OrgLoop engine.
 *
 * Reads stdin and POSTs the raw JSON body to the engine's webhook endpoint.
 * This is a stdin-to-HTTP bridge — the connector's webhook handler builds
 * the OrgLoopEvent from the raw payload.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_PORT = 4800;
const OPENCLAW_SESSIONS_DIR = join(
	homedir(),
	'.openclaw',
	'scripts',
	'agent-ctl',
	'sessions',
	'completed',
);

// ─── Helpers ────────────────────────────────────────────────────────────────

export function isConnectionError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	// Node fetch throws with code ECONNREFUSED or UND_ERR_CONNECT_TIMEOUT
	if ('code' in err && typeof err.code === 'string') {
		const code = err.code;
		if (
			code === 'ECONNREFUSED' ||
			code === 'ECONNRESET' ||
			code === 'ENOTFOUND' ||
			code === 'UND_ERR_CONNECT_TIMEOUT'
		) {
			return true;
		}
	}
	// Node's undici may throw "fetch failed" as the message wrapping a cause
	if (err.message === 'fetch failed' && 'cause' in err) {
		return isConnectionError(err.cause);
	}
	// Fallback: "fetch failed" without a cause — still a connection issue
	if (err.message === 'fetch failed') return true;
	return false;
}

function resolvePort(portFlag?: string): number {
	if (portFlag) {
		const n = Number.parseInt(portFlag, 10);
		if (!Number.isNaN(n) && n > 0 && n <= 65535) return n;
	}
	const envPort = process.env.ORGLOOP_PORT;
	if (envPort) {
		const n = Number.parseInt(envPort, 10);
		if (!Number.isNaN(n) && n > 0 && n <= 65535) return n;
	}
	return DEFAULT_PORT;
}

export function readStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = '';
		process.stdin.setEncoding('utf-8');
		process.stdin.on('data', (chunk) => {
			data += chunk;
		});
		process.stdin.on('end', () => resolve(data));
		process.stdin.on('error', reject);
	});
}

export async function postToWebhook(
	sourceId: string,
	body: string,
	port: number,
): Promise<{ ok: boolean; status: number; body: string }> {
	const url = `http://127.0.0.1:${port}/webhook/${sourceId}`;
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body,
	});
	const text = await res.text();
	return { ok: res.ok, status: res.status, body: text };
}

// ─── Claude Code payload transform ──────────────────────────────────────────

/** Raw payload from Claude Code's stop hook (stdin JSON). */
interface ClaudeCodeStdinPayload {
	session_id?: string;
	cwd?: string;
	transcript_path?: string;
}

/** Normalized payload expected by the ClaudeCodeSource webhook handler. */
interface ClaudeCodeWebhookPayload {
	session_id: string;
	working_directory: string;
	duration_seconds: number;
	exit_status: number;
	summary: string;
	transcript_path: string;
}

/**
 * Try to find session metadata from OpenClaw's completed sessions directory.
 * Returns enrichment fields or empty defaults.
 */
export function readOpenClawSession(
	sessionId: string,
	sessionsDir = OPENCLAW_SESSIONS_DIR,
): { duration_seconds: number; exit_status: number; summary: string } {
	const defaults = { duration_seconds: 0, exit_status: 0, summary: '' };
	try {
		if (!existsSync(sessionsDir)) return defaults;
		// Look for a file matching the session ID
		const files = readdirSync(sessionsDir);
		const match = files.find((f) => f.includes(sessionId));
		if (!match) return defaults;

		const content = readFileSync(join(sessionsDir, match), 'utf-8');
		const data = JSON.parse(content);
		return {
			duration_seconds:
				typeof data.duration_seconds === 'number'
					? data.duration_seconds
					: defaults.duration_seconds,
			exit_status: typeof data.exit_status === 'number' ? data.exit_status : defaults.exit_status,
			summary: typeof data.summary === 'string' ? data.summary : defaults.summary,
		};
	} catch {
		return defaults;
	}
}

/**
 * Transform the raw Claude Code stop hook stdin payload into the shape
 * expected by the ClaudeCodeSource webhook handler.
 */
export function transformClaudeCodePayload(raw: ClaudeCodeStdinPayload): ClaudeCodeWebhookPayload {
	const sessionId = raw.session_id ?? '';
	const enrichment = sessionId
		? readOpenClawSession(sessionId)
		: { duration_seconds: 0, exit_status: 0, summary: '' };

	return {
		session_id: sessionId,
		working_directory: raw.cwd ?? '',
		duration_seconds: enrichment.duration_seconds,
		exit_status: enrichment.exit_status,
		summary: enrichment.summary,
		transcript_path: raw.transcript_path ?? '',
	};
}

// ─── Command registration ────────────────────────────────────────────────────

interface GenericHookActionOptions {
	source?: string;
	port?: string;
}

function makeGenericHookAction(defaultSource: string) {
	return async (opts: GenericHookActionOptions): Promise<void> => {
		const port = resolvePort(opts.port);
		let body: string;
		try {
			body = await readStdin();
		} catch {
			process.stderr.write('orgloop hook: failed to read stdin\n');
			process.exitCode = 1;
			return;
		}
		try {
			const result = await postToWebhook(opts.source ?? defaultSource, body, port);
			if (!result.ok) {
				process.stderr.write(`orgloop hook: webhook returned ${result.status}: ${result.body}\n`);
				process.exitCode = 1;
			}
		} catch (err) {
			if (isConnectionError(err)) return;
			process.stderr.write(`orgloop hook: ${err instanceof Error ? err.message : String(err)}\n`);
			process.exitCode = 1;
		}
	};
}

export function registerHookCommand(program: Command): void {
	const hook = program.command('hook').description('Forward hook events to running OrgLoop engine');

	// claude-code-stop is special: enriches the payload with OpenClaw session metadata
	// before posting. All other harnesses are raw stdin pass-through.
	hook
		.command('claude-code-stop')
		.description('Forward Claude Code stop hook event (with OpenClaw enrichment)')
		.option('--port <port>', 'Engine webhook port')
		.option('--source <id>', 'Source ID to deliver to', 'claude-code')
		.action(async (opts: GenericHookActionOptions) => {
			const port = resolvePort(opts.port);

			let body: string;
			try {
				body = await readStdin();
			} catch {
				process.stderr.write('orgloop hook: failed to read stdin\n');
				process.exitCode = 1;
				return;
			}

			// Transform Claude Code's stdin payload to the webhook-expected shape
			try {
				const raw = JSON.parse(body) as ClaudeCodeStdinPayload;
				const transformed = transformClaudeCodePayload(raw);
				body = JSON.stringify(transformed);
			} catch {
				// If JSON parse fails, send as-is — the webhook handler will return 400
			}

			try {
				const result = await postToWebhook(opts.source ?? 'claude-code', body, port);
				if (!result.ok) {
					process.stderr.write(`orgloop hook: webhook returned ${result.status}: ${result.body}\n`);
					process.exitCode = 1;
				}
			} catch (err) {
				if (isConnectionError(err)) return;
				process.stderr.write(`orgloop hook: ${err instanceof Error ? err.message : String(err)}\n`);
				process.exitCode = 1;
			}
		});

	// Generic stop hooks — raw stdin pass-through. The source's webhook handler
	// resolves lifecycle phase from the payload.
	hook
		.command('codex-stop')
		.description('Forward Codex stop hook event')
		.option('--port <port>', 'Engine webhook port')
		.option('--source <id>', 'Source ID to deliver to', 'codex')
		.action(makeGenericHookAction('codex'));

	hook
		.command('opencode-stop')
		.description('Forward OpenCode stop hook event')
		.option('--port <port>', 'Engine webhook port')
		.option('--source <id>', 'Source ID to deliver to', 'opencode')
		.action(makeGenericHookAction('opencode'));

	hook
		.command('pi-stop')
		.description('Forward Pi stop hook event')
		.option('--port <port>', 'Engine webhook port')
		.option('--source <id>', 'Source ID to deliver to', 'pi')
		.action(makeGenericHookAction('pi'));

	hook
		.command('pi-rust-stop')
		.description('Forward pi-rust stop hook event')
		.option('--port <port>', 'Engine webhook port')
		.option('--source <id>', 'Source ID to deliver to', 'pi-rust')
		.action(makeGenericHookAction('pi-rust'));

	// Generic start hooks — raw stdin pass-through. Payloads include
	// `hook_type: 'start'` so the webhook handler emits resource.changed.
	hook
		.command('claude-code-start')
		.description('Forward Claude Code start hook event')
		.option('--port <port>', 'Engine webhook port')
		.option('--source <id>', 'Source ID to deliver to', 'claude-code')
		.action(makeGenericHookAction('claude-code'));

	hook
		.command('codex-start')
		.description('Forward Codex start hook event')
		.option('--port <port>', 'Engine webhook port')
		.option('--source <id>', 'Source ID to deliver to', 'codex')
		.action(makeGenericHookAction('codex'));
}
