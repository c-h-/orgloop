import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeSource } from '../source.js';

const TEST_SECRET = 'test-webhook-secret-key';

function createMockRequest(
	body: string,
	method = 'POST',
	headers: Record<string, string> = {},
): IncomingMessage {
	const req = new EventEmitter() as unknown as IncomingMessage;
	req.method = method;
	req.headers = { ...headers };
	// Simulate incoming data
	setTimeout(() => {
		(req as EventEmitter).emit('data', Buffer.from(body));
		(req as EventEmitter).emit('end');
	}, 0);
	return req;
}

function createMockResponse(): ServerResponse & { statusCode: number; body: string } {
	const res = {
		statusCode: 200,
		body: '',
		writeHead(code: number, _headers?: Record<string, string>) {
			res.statusCode = code;
			return res;
		},
		end(data?: string) {
			res.body = data ?? '';
			return res;
		},
	} as unknown as ServerResponse & { statusCode: number; body: string };
	return res;
}

function signPayload(body: string, secret: string): string {
	return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

const samplePayload = {
	session_id: 'sess-123',
	working_directory: '/tmp/test',
	duration_seconds: 120,
	exit_status: 0,
	summary: 'Task completed',
};

describe('ClaudeCodeSource', () => {
	it('initializes without error', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'claude-code',
			connector: '@orgloop/connector-claude-code',
			config: { hook_type: 'post-exit' },
		});
		expect(source.id).toBe('claude-code');
	});

	it('returns empty events on initial poll', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'claude-code',
			connector: '@orgloop/connector-claude-code',
			config: {},
		});
		const result = await source.poll(null);
		expect(result.events).toHaveLength(0);
		expect(result.checkpoint).toBeDefined();
	});

	it('receives webhook events and returns them on poll', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'claude-code',
			connector: '@orgloop/connector-claude-code',
			config: {},
		});

		const handler = source.webhook();
		const payload = {
			session_id: 'sess-123',
			working_directory: '/tmp/test',
			duration_seconds: 120,
			exit_status: 0,
			summary: 'Task completed',
		};

		const req = createMockRequest(JSON.stringify(payload));
		const res = createMockResponse();
		const events = await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('actor.stopped');
		expect(events[0].source).toBe('claude-code');
		expect(events[0].provenance.platform).toBe('claude-code');
		expect(events[0].payload.session_id).toBe('sess-123');

		// Now poll should drain the events
		const result = await source.poll(null);
		expect(result.events).toHaveLength(1);
		expect(result.events[0].id).toBe(events[0].id);

		// Second poll should be empty
		const result2 = await source.poll(result.checkpoint);
		expect(result2.events).toHaveLength(0);
	});

	it('rejects non-POST requests', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'claude-code',
			connector: '@orgloop/connector-claude-code',
			config: {},
		});

		const handler = source.webhook();
		const req = createMockRequest('', 'GET');
		const res = createMockResponse();
		const events = await handler(req, res);

		expect(res.statusCode).toBe(405);
		expect(events).toHaveLength(0);
	});

	it('rejects invalid JSON', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'claude-code',
			connector: '@orgloop/connector-claude-code',
			config: {},
		});

		const handler = source.webhook();
		const req = createMockRequest('not-json');
		const res = createMockResponse();
		const events = await handler(req, res);

		expect(res.statusCode).toBe(400);
		expect(events).toHaveLength(0);
	});

	it('cleans up on shutdown', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'claude-code',
			connector: '@orgloop/connector-claude-code',
			config: {},
		});

		// Add an event via webhook
		const handler = source.webhook();
		const req = createMockRequest(
			JSON.stringify({
				session_id: 'sess-456',
				working_directory: '/tmp',
				duration_seconds: 60,
				exit_status: 0,
			}),
		);
		const res = createMockResponse();
		await handler(req, res);

		await source.shutdown();

		// After shutdown, pending events should be cleared
		const result = await source.poll(null);
		expect(result.events).toHaveLength(0);
	});
});

describe('ClaudeCodeSource HMAC validation', () => {
	it('accepts webhook with valid HMAC signature via x-hub-signature-256', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'claude-code',
			connector: '@orgloop/connector-claude-code',
			config: { secret: TEST_SECRET },
		});

		const handler = source.webhook();
		const body = JSON.stringify(samplePayload);
		const signature = signPayload(body, TEST_SECRET);

		const req = createMockRequest(body, 'POST', { 'x-hub-signature-256': signature });
		const res = createMockResponse();
		const events = await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('actor.stopped');
		expect(events[0].payload.session_id).toBe('sess-123');
	});

	it('accepts webhook with valid HMAC signature via x-signature', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'claude-code',
			connector: '@orgloop/connector-claude-code',
			config: { secret: TEST_SECRET },
		});

		const handler = source.webhook();
		const body = JSON.stringify(samplePayload);
		const signature = signPayload(body, TEST_SECRET);

		const req = createMockRequest(body, 'POST', { 'x-signature': signature });
		const res = createMockResponse();
		const events = await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(events).toHaveLength(1);
	});

	it('rejects webhook with invalid HMAC signature', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'claude-code',
			connector: '@orgloop/connector-claude-code',
			config: { secret: TEST_SECRET },
		});

		const handler = source.webhook();
		const body = JSON.stringify(samplePayload);
		const badSignature = signPayload(body, 'wrong-secret');

		const req = createMockRequest(body, 'POST', { 'x-hub-signature-256': badSignature });
		const res = createMockResponse();
		const events = await handler(req, res);

		expect(res.statusCode).toBe(401);
		expect(events).toHaveLength(0);
		expect(JSON.parse(res.body).error).toBe('Invalid signature');
	});

	it('rejects webhook with missing signature when secret is configured', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'claude-code',
			connector: '@orgloop/connector-claude-code',
			config: { secret: TEST_SECRET },
		});

		const handler = source.webhook();
		const body = JSON.stringify(samplePayload);

		const req = createMockRequest(body, 'POST');
		const res = createMockResponse();
		const events = await handler(req, res);

		expect(res.statusCode).toBe(401);
		expect(events).toHaveLength(0);
		expect(JSON.parse(res.body).error).toBe('Missing signature');
	});

	it('accepts all requests when no secret is configured (backward compat)', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'claude-code',
			connector: '@orgloop/connector-claude-code',
			config: {},
		});

		const handler = source.webhook();
		const body = JSON.stringify(samplePayload);

		const req = createMockRequest(body, 'POST');
		const res = createMockResponse();
		const events = await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(events).toHaveLength(1);
	});

	it('resolves secret from env var reference', async () => {
		const envKey = 'TEST_CLAUDE_CODE_SECRET';
		process.env[envKey] = TEST_SECRET;
		try {
			const source = new ClaudeCodeSource();
			await source.init({
				id: 'claude-code',
				connector: '@orgloop/connector-claude-code',
				config: { secret: `\${${envKey}}` },
			});

			const handler = source.webhook();
			const body = JSON.stringify(samplePayload);
			const signature = signPayload(body, TEST_SECRET);

			const req = createMockRequest(body, 'POST', { 'x-hub-signature-256': signature });
			const res = createMockResponse();
			const events = await handler(req, res);

			expect(res.statusCode).toBe(200);
			expect(events).toHaveLength(1);
		} finally {
			delete process.env[envKey];
		}
	});

	it('rejects tampered body even with valid-format signature', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'claude-code',
			connector: '@orgloop/connector-claude-code',
			config: { secret: TEST_SECRET },
		});

		const handler = source.webhook();
		const originalBody = JSON.stringify(samplePayload);
		const signature = signPayload(originalBody, TEST_SECRET);

		// Tamper with the body after signing
		const tamperedPayload = { ...samplePayload, exit_status: 1 };
		const tamperedBody = JSON.stringify(tamperedPayload);

		const req = createMockRequest(tamperedBody, 'POST', {
			'x-hub-signature-256': signature,
		});
		const res = createMockResponse();
		const events = await handler(req, res);

		expect(res.statusCode).toBe(401);
		expect(events).toHaveLength(0);
	});
});

describe('ClaudeCodeSource cwd alias and transcript_path', () => {
	it('accepts cwd as alias for working_directory', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'claude-code',
			connector: '@orgloop/connector-claude-code',
			config: {},
		});

		const handler = source.webhook();
		const payload = {
			session_id: 'sess-cwd-alias',
			cwd: '/home/user/project',
			duration_seconds: 60,
			exit_status: 0,
		};

		const req = createMockRequest(JSON.stringify(payload));
		const res = createMockResponse();
		const events = await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(events).toHaveLength(1);
		expect(events[0].payload.working_directory).toBe('/home/user/project');
		expect(events[0].provenance.working_directory).toBe('/home/user/project');
	});

	it('prefers working_directory over cwd when both are present', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'claude-code',
			connector: '@orgloop/connector-claude-code',
			config: {},
		});

		const handler = source.webhook();
		const payload = {
			session_id: 'sess-both',
			working_directory: '/explicit/path',
			cwd: '/cwd/path',
			duration_seconds: 30,
			exit_status: 0,
		};

		const req = createMockRequest(JSON.stringify(payload));
		const res = createMockResponse();
		const events = await handler(req, res);

		expect(events[0].payload.working_directory).toBe('/explicit/path');
	});

	it('includes transcript_path in event payload', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'claude-code',
			connector: '@orgloop/connector-claude-code',
			config: {},
		});

		const handler = source.webhook();
		const payload = {
			session_id: 'sess-transcript',
			working_directory: '/tmp/work',
			duration_seconds: 90,
			exit_status: 0,
			transcript_path: '/tmp/transcripts/sess-transcript.json',
		};

		const req = createMockRequest(JSON.stringify(payload));
		const res = createMockResponse();
		const events = await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(events[0].payload.transcript_path).toBe('/tmp/transcripts/sess-transcript.json');
	});

	it('defaults transcript_path to empty string when not provided', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'claude-code',
			connector: '@orgloop/connector-claude-code',
			config: {},
		});

		const handler = source.webhook();
		const payload = {
			session_id: 'sess-no-transcript',
			working_directory: '/tmp',
			duration_seconds: 10,
			exit_status: 0,
		};

		const req = createMockRequest(JSON.stringify(payload));
		const res = createMockResponse();
		const events = await handler(req, res);

		expect(events[0].payload.transcript_path).toBe('');
	});

	it('defaults working_directory to empty string when neither field present', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'claude-code',
			connector: '@orgloop/connector-claude-code',
			config: {},
		});

		const handler = source.webhook();
		const payload = {
			session_id: 'sess-no-dir',
			duration_seconds: 5,
			exit_status: 0,
		};

		const req = createMockRequest(JSON.stringify(payload));
		const res = createMockResponse();
		const events = await handler(req, res);

		expect(events[0].payload.working_directory).toBe('');
	});
});

describe('ClaudeCodeSource buffer persistence', () => {
	let bufferDir: string;

	beforeEach(() => {
		bufferDir = join(
			tmpdir(),
			`orgloop-test-buffer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(bufferDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(bufferDir)) {
			rmSync(bufferDir, { recursive: true, force: true });
		}
	});

	it('persists events to JSONL file on disk', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'test-src',
			connector: '@orgloop/connector-claude-code',
			config: { buffer_dir: bufferDir },
		});

		const handler = source.webhook();
		const body = JSON.stringify(samplePayload);
		const req = createMockRequest(body);
		const res = createMockResponse();
		await handler(req, res);

		expect(res.statusCode).toBe(200);

		// Verify the JSONL file exists and has content
		const bufferPath = join(bufferDir, 'claude-code-test-src.jsonl');
		expect(existsSync(bufferPath)).toBe(true);

		const content = readFileSync(bufferPath, 'utf-8').trim();
		const lines = content.split('\n');
		expect(lines).toHaveLength(1);

		const persisted = JSON.parse(lines[0]);
		expect(persisted.type).toBe('actor.stopped');
		expect(persisted.payload.session_id).toBe('sess-123');
	});

	it('poll drains buffer and clears file', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'test-src',
			connector: '@orgloop/connector-claude-code',
			config: { buffer_dir: bufferDir },
		});

		const handler = source.webhook();

		// Send two events
		for (const sid of ['sess-001', 'sess-002']) {
			const body = JSON.stringify({ ...samplePayload, session_id: sid });
			const req = createMockRequest(body);
			const res = createMockResponse();
			await handler(req, res);
		}

		const result = await source.poll(null);
		expect(result.events).toHaveLength(2);
		expect(result.events[0].payload.session_id).toBe('sess-001');
		expect(result.events[1].payload.session_id).toBe('sess-002');

		// Buffer file should be cleared
		const bufferPath = join(bufferDir, 'claude-code-test-src.jsonl');
		const content = readFileSync(bufferPath, 'utf-8');
		expect(content).toBe('');

		// Second poll should be empty
		const result2 = await source.poll(result.checkpoint);
		expect(result2.events).toHaveLength(0);
	});

	it('survives crash — new instance reads buffered events', async () => {
		// First instance writes events
		const source1 = new ClaudeCodeSource();
		await source1.init({
			id: 'test-src',
			connector: '@orgloop/connector-claude-code',
			config: { buffer_dir: bufferDir },
		});

		const handler1 = source1.webhook();
		const body = JSON.stringify(samplePayload);
		const req = createMockRequest(body);
		const res = createMockResponse();
		await handler1(req, res);

		// Simulate crash — don't poll or shutdown, just abandon the instance

		// Second instance picks up buffered events via poll
		const source2 = new ClaudeCodeSource();
		await source2.init({
			id: 'test-src',
			connector: '@orgloop/connector-claude-code',
			config: { buffer_dir: bufferDir },
		});

		const result = await source2.poll(null);
		expect(result.events).toHaveLength(1);
		expect(result.events[0].type).toBe('actor.stopped');
		expect(result.events[0].payload.session_id).toBe('sess-123');
	});

	it('creates buffer directory if it does not exist', async () => {
		const nestedDir = join(bufferDir, 'nested', 'deep');
		expect(existsSync(nestedDir)).toBe(false);

		const source = new ClaudeCodeSource();
		await source.init({
			id: 'test-src',
			connector: '@orgloop/connector-claude-code',
			config: { buffer_dir: nestedDir },
		});

		expect(existsSync(nestedDir)).toBe(true);
	});

	it('works with HMAC and buffer persistence together', async () => {
		const source = new ClaudeCodeSource();
		await source.init({
			id: 'test-src',
			connector: '@orgloop/connector-claude-code',
			config: { secret: TEST_SECRET, buffer_dir: bufferDir },
		});

		const handler = source.webhook();
		const body = JSON.stringify(samplePayload);
		const signature = signPayload(body, TEST_SECRET);

		const req = createMockRequest(body, 'POST', { 'x-hub-signature-256': signature });
		const res = createMockResponse();
		const events = await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(events).toHaveLength(1);

		// Verify persisted to disk
		const bufferPath = join(bufferDir, 'claude-code-test-src.jsonl');
		expect(existsSync(bufferPath)).toBe(true);

		// Poll reads from disk
		const result = await source.poll(null);
		expect(result.events).toHaveLength(1);
		expect(result.events[0].payload.session_id).toBe('sess-123');
	});

	it('handles empty buffer file gracefully', async () => {
		const bufferPath = join(bufferDir, 'claude-code-test-src.jsonl');
		writeFileSync(bufferPath, '');

		const source = new ClaudeCodeSource();
		await source.init({
			id: 'test-src',
			connector: '@orgloop/connector-claude-code',
			config: { buffer_dir: bufferDir },
		});

		const result = await source.poll(null);
		expect(result.events).toHaveLength(0);
	});
});
