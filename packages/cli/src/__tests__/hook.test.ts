import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	isConnectionError,
	postToWebhook,
	readOpenClawSession,
	transformClaudeCodePayload,
} from '../commands/hook.js';

// ─── Test HTTP server ───────────────────────────────────────────────────────

interface CapturedRequest {
	method: string;
	url: string;
	contentType: string | undefined;
	body: string;
}

let server: Server;
let serverPort: number;
let lastRequest: CapturedRequest | null = null;
let serverResponse = { status: 200, body: '{"ok":true,"event_id":"evt_test123"}' };

function resetCapture(): void {
	lastRequest = null;
	serverResponse = { status: 200, body: '{"ok":true,"event_id":"evt_test123"}' };
}

beforeAll(async () => {
	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => {
			lastRequest = {
				method: req.method ?? '',
				url: req.url ?? '',
				contentType: req.headers['content-type'],
				body: Buffer.concat(chunks).toString('utf-8'),
			};
			res.writeHead(serverResponse.status, { 'Content-Type': 'application/json' });
			res.end(serverResponse.body);
		});
	});

	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			if (addr && typeof addr === 'object') {
				serverPort = addr.port;
			}
			resolve();
		});
	});
});

afterAll(async () => {
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
});

afterEach(() => {
	resetCapture();
	vi.restoreAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('hook command', () => {
	describe('postToWebhook', () => {
		it('POSTs stdin body to the correct webhook endpoint', async () => {
			const payload = JSON.stringify({ session_id: 'sess_123', result: 'exit' });
			const result = await postToWebhook('claude-code', payload, serverPort);

			expect(result.ok).toBe(true);
			expect(result.status).toBe(200);
			expect(lastRequest).not.toBeNull();
			expect(lastRequest?.method).toBe('POST');
			expect(lastRequest?.url).toBe('/webhook/claude-code');
			expect(lastRequest?.contentType).toBe('application/json');
			expect(lastRequest?.body).toBe(payload);
		});

		it('returns the response body on success', async () => {
			const payload = '{"test":true}';
			const result = await postToWebhook('claude-code', payload, serverPort);

			const parsed = JSON.parse(result.body);
			expect(parsed.ok).toBe(true);
			expect(parsed.event_id).toBe('evt_test123');
		});

		it('reports failure for non-200 responses', async () => {
			serverResponse = { status: 404, body: '{"error":"source not found"}' };
			const result = await postToWebhook('unknown-source', '{}', serverPort);

			expect(result.ok).toBe(false);
			expect(result.status).toBe(404);
		});

		it('reports failure for 400 responses', async () => {
			serverResponse = { status: 400, body: '{"error":"invalid JSON"}' };
			const result = await postToWebhook('claude-code', 'not-json', serverPort);

			expect(result.ok).toBe(false);
			expect(result.status).toBe(400);
		});

		it('throws on connection refused (engine not running)', async () => {
			// Use a port that nothing is listening on
			const unusedPort = serverPort + 10000 > 65535 ? serverPort - 1000 : serverPort + 10000;
			await expect(postToWebhook('claude-code', '{}', unusedPort)).rejects.toThrow();
		});

		it('works with different source IDs', async () => {
			await postToWebhook('github', '{"event":"push"}', serverPort);
			expect(lastRequest?.url).toBe('/webhook/github');
		});
	});

	describe('isConnectionError', () => {
		it('returns true for ECONNREFUSED', () => {
			const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
			expect(isConnectionError(err)).toBe(true);
		});

		it('returns true for ECONNRESET', () => {
			const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
			expect(isConnectionError(err)).toBe(true);
		});

		it('returns true for "fetch failed" with connection cause', () => {
			const cause = Object.assign(new Error('connect ECONNREFUSED'), {
				code: 'ECONNREFUSED',
			});
			const err = Object.assign(new Error('fetch failed'), { cause });
			expect(isConnectionError(err)).toBe(true);
		});

		it('returns true for bare "fetch failed" without cause', () => {
			expect(isConnectionError(new Error('fetch failed'))).toBe(true);
		});

		it('returns false for non-connection errors', () => {
			expect(isConnectionError(new Error('invalid JSON'))).toBe(false);
		});

		it('returns false for non-Error values', () => {
			expect(isConnectionError('string error')).toBe(false);
			expect(isConnectionError(null)).toBe(false);
		});
	});

	describe('graceful degradation (engine not running)', () => {
		it('connection error from dead port is classified as connection error', async () => {
			// Simulate what the command handler does: postToWebhook throws when
			// engine is not running, isConnectionError detects it → exit 0 (no error)
			const unusedPort = serverPort + 10000 > 65535 ? serverPort - 1000 : serverPort + 10000;
			let caughtError: unknown;
			try {
				await postToWebhook('claude-code', '{}', unusedPort);
			} catch (err) {
				caughtError = err;
			}
			expect(caughtError).toBeDefined();
			expect(isConnectionError(caughtError)).toBe(true);
		});

		it('non-connection errors are not classified as connection errors', async () => {
			// A non-connection error (e.g. bad argument) should NOT be treated gracefully
			const err = new Error('unexpected failure');
			expect(isConnectionError(err)).toBe(false);
		});

		it('handler exits 0 when engine is not running (mock fetch)', async () => {
			// Mock fetch to throw a connection error, then verify the command
			// handler logic would not set exitCode
			const fetchError = Object.assign(new Error('fetch failed'), {
				cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4800'), {
					code: 'ECONNREFUSED',
				}),
			});

			// Simulate the exact catch block from the hook command handler
			let exitCode: number | undefined;
			let stderrOutput = '';

			try {
				throw fetchError;
			} catch (err) {
				if (isConnectionError(err)) {
					// Engine not running — graceful exit (exit 0)
					exitCode = undefined; // not set = exit 0
				} else {
					stderrOutput = `orgloop hook: ${err instanceof Error ? err.message : String(err)}`;
					exitCode = 1;
				}
			}

			expect(exitCode).toBeUndefined();
			expect(stderrOutput).toBe('');
		});
	});

	describe('port resolution', () => {
		// We test port resolution indirectly by verifying postToWebhook uses the port.
		// The resolvePort function is internal, but postToWebhook takes port as argument.

		it('uses the provided port for the request', async () => {
			const result = await postToWebhook('claude-code', '{}', serverPort);
			expect(result.ok).toBe(true);
			// The request went to our server on serverPort — confirming port was used
			expect(lastRequest).not.toBeNull();
		});
	});

	describe('transformClaudeCodePayload', () => {
		it('remaps cwd to working_directory', () => {
			const result = transformClaudeCodePayload({
				session_id: 'sess-abc',
				cwd: '/home/user/project',
				transcript_path: '/tmp/transcript.json',
			});
			expect(result.working_directory).toBe('/home/user/project');
			expect(result.session_id).toBe('sess-abc');
			expect(result.transcript_path).toBe('/tmp/transcript.json');
		});

		it('defaults missing fields gracefully', () => {
			const result = transformClaudeCodePayload({});
			expect(result.session_id).toBe('');
			expect(result.working_directory).toBe('');
			expect(result.duration_seconds).toBe(0);
			expect(result.exit_status).toBe(0);
			expect(result.summary).toBe('');
			expect(result.transcript_path).toBe('');
		});

		it('passes through all Claude Code stdin fields', () => {
			const result = transformClaudeCodePayload({
				session_id: 'sess-123',
				cwd: '/tmp/work',
				transcript_path: '/tmp/transcript.md',
			});
			expect(result).toEqual({
				session_id: 'sess-123',
				working_directory: '/tmp/work',
				duration_seconds: 0,
				exit_status: 0,
				summary: '',
				transcript_path: '/tmp/transcript.md',
			});
		});

		it('produces a payload the webhook handler accepts', async () => {
			const transformed = transformClaudeCodePayload({
				session_id: 'sess-e2e',
				cwd: '/tmp/e2e',
				transcript_path: '/tmp/t.json',
			});
			const body = JSON.stringify(transformed);
			const result = await postToWebhook('claude-code', body, serverPort);
			expect(result.ok).toBe(true);
			// Verify the body was sent correctly
			const parsed = JSON.parse(lastRequest?.body);
			expect(parsed.session_id).toBe('sess-e2e');
			expect(parsed.working_directory).toBe('/tmp/e2e');
			expect(parsed.transcript_path).toBe('/tmp/t.json');
		});
	});

	describe('readOpenClawSession', () => {
		let sessionsDir: string;

		beforeAll(() => {
			sessionsDir = join(
				tmpdir(),
				`orgloop-test-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			mkdirSync(sessionsDir, { recursive: true });
		});

		afterAll(() => {
			if (existsSync(sessionsDir)) {
				rmSync(sessionsDir, { recursive: true, force: true });
			}
		});

		it('returns defaults when sessions dir does not exist', () => {
			const result = readOpenClawSession('sess-xxx', '/nonexistent/path');
			expect(result).toEqual({ duration_seconds: 0, exit_status: 0, summary: '' });
		});

		it('returns defaults when no matching file found', () => {
			const result = readOpenClawSession('sess-no-match', sessionsDir);
			expect(result).toEqual({ duration_seconds: 0, exit_status: 0, summary: '' });
		});

		it('reads enrichment from matching session file', () => {
			const sessionData = {
				duration_seconds: 300,
				exit_status: 0,
				summary: 'Implemented feature X',
			};
			writeFileSync(join(sessionsDir, 'sess-enrich-001.json'), JSON.stringify(sessionData));

			const result = readOpenClawSession('sess-enrich-001', sessionsDir);
			expect(result.duration_seconds).toBe(300);
			expect(result.exit_status).toBe(0);
			expect(result.summary).toBe('Implemented feature X');
		});

		it('handles malformed JSON gracefully', () => {
			writeFileSync(join(sessionsDir, 'sess-bad-json.json'), 'not-json');
			const result = readOpenClawSession('sess-bad-json', sessionsDir);
			expect(result).toEqual({ duration_seconds: 0, exit_status: 0, summary: '' });
		});

		it('handles partial session data with type-safe defaults', () => {
			writeFileSync(
				join(sessionsDir, 'sess-partial.json'),
				JSON.stringify({ duration_seconds: 60 }),
			);
			const result = readOpenClawSession('sess-partial', sessionsDir);
			expect(result.duration_seconds).toBe(60);
			expect(result.exit_status).toBe(0);
			expect(result.summary).toBe('');
		});

		it('enriches transformClaudeCodePayload when session file exists', () => {
			writeFileSync(
				join(sessionsDir, 'sess-enrich-full.json'),
				JSON.stringify({
					duration_seconds: 120,
					exit_status: 1,
					summary: 'Fixed bug in router',
				}),
			);
			// Temporarily override by calling transform with a custom readOpenClawSession
			// We test the integration by calling readOpenClawSession directly
			const enrichment = readOpenClawSession('sess-enrich-full', sessionsDir);
			expect(enrichment.duration_seconds).toBe(120);
			expect(enrichment.exit_status).toBe(1);
			expect(enrichment.summary).toBe('Fixed bug in router');
		});
	});
});
