/**
 * orgloop hook — Forward hook events to a running OrgLoop engine.
 *
 * Reads stdin and POSTs the raw JSON body to the engine's webhook endpoint.
 * This is a stdin-to-HTTP bridge — the connector's webhook handler builds
 * the OrgLoopEvent from the raw payload.
 */

import type { Command } from 'commander';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_PORT = 4800;

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

// ─── Command registration ────────────────────────────────────────────────────

export function registerHookCommand(program: Command): void {
	const hook = program.command('hook').description('Forward hook events to running OrgLoop engine');

	hook
		.command('claude-code-stop')
		.description('Forward Claude Code stop hook event')
		.option('--port <port>', 'Engine webhook port')
		.action(async (opts) => {
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
				const result = await postToWebhook('claude-code', body, port);
				if (!result.ok) {
					process.stderr.write(`orgloop hook: webhook returned ${result.status}: ${result.body}\n`);
					process.exitCode = 1;
				}
			} catch (err) {
				// Hook delivery is opportunistic — if the engine isn't running,
				// degrade gracefully. The host tool should never feel broken.
				if (isConnectionError(err)) {
					// Engine not running — this is normal, exit 0 silently
					return;
				}
				// Genuine error (malformed request, unexpected failure) — report it
				process.stderr.write(`orgloop hook: ${err instanceof Error ? err.message : String(err)}\n`);
				process.exitCode = 1;
			}
		});
}
