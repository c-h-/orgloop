import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isConnectionError, postToWebhook } from '../commands/hook.js';

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
});
