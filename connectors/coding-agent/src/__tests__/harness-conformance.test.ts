/**
 * Harness conformance — parametrized over every HARNESS_PROFILES entry.
 *
 * This file enforces that every coding-agent harness profile produces
 * normalized lifecycle events. Adding a harness #6 requires only adding
 * a profile to HARNESS_PROFILES; the conformance matrix here will run
 * the same assertions against it automatically.
 *
 * Sources the profile list from HARNESS_PROFILES (the same registry the
 * connector uses at runtime) so there is exactly one source of truth.
 */

import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { assertLifecycleConformance } from '@orgloop/sdk';
import { describe, expect, it } from 'vitest';
import { HARNESS_PROFILES, type HarnessName } from '../harness-profiles/index.js';
import { CodingAgentSource } from '../source.js';

const TEST_SECRET = 'test-webhook-secret-key';

function createMockRequest(body: string, headers: Record<string, string> = {}): IncomingMessage {
	const req = new EventEmitter() as unknown as IncomingMessage;
	req.method = 'POST';
	req.headers = { ...headers };
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

function signPayload(body: string, secret: string, algo = 'sha256'): string {
	return `${algo}=${createHmac(algo, secret).update(body).digest('hex')}`;
}

const harnesses = Object.keys(HARNESS_PROFILES) as HarnessName[];

describe.each(harnesses)('harness conformance — %s', (harness) => {
	const profile = HARNESS_PROFILES[harness];

	async function makeSource(extraConfig: Record<string, unknown> = {}): Promise<CodingAgentSource> {
		const source = new CodingAgentSource();
		await source.init({
			id: harness,
			connector: '@orgloop/connector-coding-agent',
			config: { harness, ...extraConfig },
		});
		return source;
	}

	it('emits actor.stopped for exit_status 0 (completed/success)', async () => {
		const source = await makeSource();
		const handler = source.webhook();
		const req = createMockRequest(
			JSON.stringify({ session_id: 'sess-1', exit_status: 0, duration_seconds: 60 }),
		);
		const res = createMockResponse();
		const events = await handler(req, res);
		expect(events).toHaveLength(1);
		const [event] = events;
		assertLifecycleConformance(event);
		expect(event.type).toBe('actor.stopped');
		expect(event.provenance.platform).toBe(harness);
		const lc = event.payload.lifecycle as Record<string, unknown>;
		expect(lc.phase).toBe('completed');
		expect(lc.outcome).toBe('success');
		expect(lc.dedupe_key).toBe(`${harness}:sess-1:completed`);
	});

	it('emits actor.stopped for exit_status 1 (failed/failure)', async () => {
		const source = await makeSource();
		const handler = source.webhook();
		const req = createMockRequest(
			JSON.stringify({ session_id: 'sess-2', exit_status: 1, duration_seconds: 5 }),
		);
		const res = createMockResponse();
		const [event] = await handler(req, res);
		assertLifecycleConformance(event);
		expect(event.type).toBe('actor.stopped');
		const lc = event.payload.lifecycle as Record<string, unknown>;
		expect(lc.phase).toBe('failed');
		expect(lc.outcome).toBe('failure');
	});

	it('emits actor.stopped for SIGINT 130 (stopped/cancelled/sigint)', async () => {
		const source = await makeSource();
		const handler = source.webhook();
		const req = createMockRequest(JSON.stringify({ session_id: 'sess-3', exit_status: 130 }));
		const res = createMockResponse();
		const [event] = await handler(req, res);
		assertLifecycleConformance(event);
		const lc = event.payload.lifecycle as Record<string, unknown>;
		expect(lc.phase).toBe('stopped');
		expect(lc.outcome).toBe('cancelled');
		expect(lc.reason).toBe('sigint');
	});

	it('emits resource.changed for hook_type=start (started/non-terminal)', async () => {
		const source = await makeSource();
		const handler = source.webhook();
		const req = createMockRequest(JSON.stringify({ session_id: 'sess-4', hook_type: 'start' }));
		const res = createMockResponse();
		const [event] = await handler(req, res);
		assertLifecycleConformance(event);
		expect(event.type).toBe('resource.changed');
		const lc = event.payload.lifecycle as Record<string, unknown>;
		expect(lc.phase).toBe('started');
		expect(lc.terminal).toBe(false);
	});

	it(`accepts valid HMAC signature via ${profile.signatureHeader}`, async () => {
		const source = await makeSource({ secret: TEST_SECRET });
		const handler = source.webhook();
		const body = JSON.stringify({ session_id: 'sess-5', exit_status: 0 });
		const sig = signPayload(body, TEST_SECRET, profile.hmacAlgorithm);
		const req = createMockRequest(body, { [profile.signatureHeader]: sig });
		const res = createMockResponse();
		const events = await handler(req, res);
		expect(res.statusCode).toBe(200);
		expect(events).toHaveLength(1);
	});

	it('rejects invalid HMAC signature', async () => {
		const source = await makeSource({ secret: TEST_SECRET });
		const handler = source.webhook();
		const body = JSON.stringify({ session_id: 'sess-6', exit_status: 0 });
		const req = createMockRequest(body, { [profile.signatureHeader]: 'sha256=bad' });
		const res = createMockResponse();
		await handler(req, res);
		expect(res.statusCode).toBe(401);
	});

	it('sets harness/adapter fields in session payload', async () => {
		const source = await makeSource();
		const handler = source.webhook();
		const req = createMockRequest(JSON.stringify({ session_id: 'sess-7', exit_status: 0 }));
		const res = createMockResponse();
		const [event] = await handler(req, res);
		const sess = event.payload.session as Record<string, unknown>;
		expect(sess.harness).toBe(harness);
		expect(sess.adapter).toBe(harness);
	});
});

// ─── Codex-specific extension ───────────────────────────────────────────────

describe('codex profile — model field propagation', () => {
	async function makeCodex(): Promise<CodingAgentSource> {
		const source = new CodingAgentSource();
		await source.init({
			id: 'codex',
			connector: '@orgloop/connector-coding-agent',
			config: { harness: 'codex' },
		});
		return source;
	}

	it('propagates model field into event payload', async () => {
		const source = await makeCodex();
		const handler = source.webhook();
		const req = createMockRequest(
			JSON.stringify({ session_id: 'sess-x', exit_status: 0, model: 'o4-mini' }),
		);
		const res = createMockResponse();
		const [event] = await handler(req, res);
		expect((event.payload as Record<string, unknown>).model).toBe('o4-mini');
	});

	it('omits model field when absent in payload', async () => {
		const source = await makeCodex();
		const handler = source.webhook();
		const req = createMockRequest(JSON.stringify({ session_id: 'sess-y', exit_status: 0 }));
		const res = createMockResponse();
		const [event] = await handler(req, res);
		expect((event.payload as Record<string, unknown>).model).toBeUndefined();
	});
});
