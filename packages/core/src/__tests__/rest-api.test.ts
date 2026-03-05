/**
 * Tests for the REST API endpoints.
 */

import { createTestEvent, MockActor, MockSource } from '@orgloop/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryBus } from '../bus.js';
import type { ModuleConfig } from '../module-instance.js';
import { registerRestApi } from '../rest-api.js';
import { Runtime } from '../runtime.js';

function makeModuleConfig(name: string, overrides?: Partial<ModuleConfig>): ModuleConfig {
	return {
		name,
		sources: [
			{
				id: `${name}-source`,
				connector: 'mock',
				config: {},
				poll: { interval: '5m' },
			},
		],
		actors: [{ id: `${name}-actor`, connector: 'mock', config: {} }],
		routes: [
			{
				name: `${name}-route`,
				when: { source: `${name}-source`, events: ['resource.changed'] },
				then: { actor: `${name}-actor` },
			},
		],
		transforms: [],
		loggers: [],
		...overrides,
	};
}

async function setupRuntime(): Promise<{
	runtime: Runtime;
	source: MockSource;
	actor: MockActor;
}> {
	const runtime = new Runtime({
		bus: new InMemoryBus(),
		crashHandlers: false,
		heartbeat: false,
	});
	await runtime.start();

	const source = new MockSource('test-source');
	const actor = new MockActor('test-actor');

	await runtime.loadModule(makeModuleConfig('test'), {
		sources: new Map([['test-source', source]]),
		actors: new Map([['test-actor', actor]]),
	});

	registerRestApi(runtime);
	return { runtime, source, actor };
}

describe('REST API', () => {
	let runtime: Runtime;

	afterEach(async () => {
		if (runtime) {
			try {
				await runtime.stop();
			} catch {
				// already stopped
			}
		}
	});

	describe('GET /api/status', () => {
		it('returns runtime status with health', async () => {
			const setup = await setupRuntime();
			runtime = setup.runtime;

			const server = runtime.getWebhookServer();
			const handler = (server as unknown as { apiHandlers: Map<string, unknown> }).apiHandlers.get(
				'status',
			) as (q: URLSearchParams) => Promise<unknown>;

			const result = (await handler(new URLSearchParams())) as Record<string, unknown>;

			expect(result.health).toBe('ok');
			expect(result.running).toBe(true);
			expect(result.pid).toBe(process.pid);
			expect(result.uptime_ms).toBeGreaterThanOrEqual(0);
			expect(result.modules).toHaveLength(1);
			expect(result.sources).toHaveLength(1);
		});
	});

	describe('GET /api/routes', () => {
		it('returns route definitions with stats', async () => {
			const setup = await setupRuntime();
			runtime = setup.runtime;

			const server = runtime.getWebhookServer();
			const handler = (server as unknown as { apiHandlers: Map<string, unknown> }).apiHandlers.get(
				'routes',
			) as (q: URLSearchParams) => Promise<unknown>;

			const result = (await handler(new URLSearchParams())) as Array<Record<string, unknown>>;

			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('test-route');
			expect(result[0].actor).toBe('test-actor');
			expect(result[0].fire_count).toBe(0);
			expect(result[0].last_fired).toBeNull();
		});

		it('increments fire count after event processing', async () => {
			const setup = await setupRuntime();
			runtime = setup.runtime;

			// Inject an event that matches the route
			const event = createTestEvent({
				source: 'test-source',
				type: 'resource.changed',
			});
			await runtime.inject(event, 'test');

			const server = runtime.getWebhookServer();
			const handler = (server as unknown as { apiHandlers: Map<string, unknown> }).apiHandlers.get(
				'routes',
			) as (q: URLSearchParams) => Promise<unknown>;

			const result = (await handler(new URLSearchParams())) as Array<Record<string, unknown>>;

			expect(result[0].fire_count).toBe(1);
			expect(result[0].last_fired).toBeTruthy();
		});
	});

	describe('GET /api/events', () => {
		it('returns empty array when no events processed', async () => {
			const setup = await setupRuntime();
			runtime = setup.runtime;

			const server = runtime.getWebhookServer();
			const handler = (server as unknown as { apiHandlers: Map<string, unknown> }).apiHandlers.get(
				'events',
			) as (q: URLSearchParams) => Promise<unknown>;

			const result = (await handler(new URLSearchParams())) as unknown[];
			expect(result).toEqual([]);
		});

		it('records events after processing', async () => {
			const setup = await setupRuntime();
			runtime = setup.runtime;

			const event = createTestEvent({
				source: 'test-source',
				type: 'resource.changed',
			});
			await runtime.inject(event, 'test');

			const server = runtime.getWebhookServer();
			const handler = (server as unknown as { apiHandlers: Map<string, unknown> }).apiHandlers.get(
				'events',
			) as (q: URLSearchParams) => Promise<unknown>;

			const result = (await handler(new URLSearchParams())) as Array<Record<string, unknown>>;

			expect(result).toHaveLength(1);
			expect(result[0].source).toBe('test-source');
			expect(result[0].type).toBe('resource.changed');
			expect(result[0].matched_routes).toEqual(['test-route']);
			expect(result[0].processing_ms).toBeGreaterThanOrEqual(0);
		});

		it('filters by source', async () => {
			const setup = await setupRuntime();
			runtime = setup.runtime;

			const event = createTestEvent({
				source: 'test-source',
				type: 'resource.changed',
			});
			await runtime.inject(event, 'test');

			const server = runtime.getWebhookServer();
			const handler = (server as unknown as { apiHandlers: Map<string, unknown> }).apiHandlers.get(
				'events',
			) as (q: URLSearchParams) => Promise<unknown>;

			const noMatch = (await handler(new URLSearchParams({ source: 'other-source' }))) as unknown[];
			expect(noMatch).toEqual([]);

			const match = (await handler(new URLSearchParams({ source: 'test-source' }))) as unknown[];
			expect(match).toHaveLength(1);
		});

		it('respects limit parameter', async () => {
			const setup = await setupRuntime();
			runtime = setup.runtime;

			for (let i = 0; i < 5; i++) {
				const event = createTestEvent({
					source: 'test-source',
					type: 'resource.changed',
				});
				await runtime.inject(event, 'test');
			}

			const server = runtime.getWebhookServer();
			const handler = (server as unknown as { apiHandlers: Map<string, unknown> }).apiHandlers.get(
				'events',
			) as (q: URLSearchParams) => Promise<unknown>;

			const result = (await handler(new URLSearchParams({ limit: '2' }))) as unknown[];
			expect(result).toHaveLength(2);
		});
	});

	describe('GET /api/sources', () => {
		it('returns source details', async () => {
			const setup = await setupRuntime();
			runtime = setup.runtime;

			const server = runtime.getWebhookServer();
			const handler = (server as unknown as { apiHandlers: Map<string, unknown> }).apiHandlers.get(
				'sources',
			) as (q: URLSearchParams) => Promise<unknown>;

			const result = (await handler(new URLSearchParams())) as Array<Record<string, unknown>>;

			expect(result).toHaveLength(1);
			expect(result[0].id).toBe('test-source');
			expect(result[0].connector).toBe('mock');
			expect(result[0].type).toBe('polling');
			expect(result[0].status).toBe('healthy');
			expect(result[0].event_count).toBe(0);
			expect(result[0].poll_interval).toBe('5m');
		});
	});

	describe('GET /api/metrics', () => {
		it('returns error message when metrics not enabled', async () => {
			const setup = await setupRuntime();
			runtime = setup.runtime;

			const server = runtime.getWebhookServer();
			const handler = (server as unknown as { apiHandlers: Map<string, unknown> }).apiHandlers.get(
				'metrics',
			) as (q: URLSearchParams) => Promise<unknown>;

			const result = (await handler(new URLSearchParams())) as Record<string, unknown>;
			expect(result.error).toContain('Metrics not enabled');
		});
	});
});
