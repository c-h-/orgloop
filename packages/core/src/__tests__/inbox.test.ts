/**
 * Inbox tests — InboxStore, InboxManager, and Runtime integration.
 */

import type { OrgLoopEvent } from '@orgloop/sdk';
import { createTestEvent, MockActor, MockSource } from '@orgloop/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryBus } from '../bus.js';
import type { InboxConfig } from '../inbox.js';
import { InboxManager } from '../inbox.js';
import { InMemoryInboxStore } from '../inbox-store.js';
import type { ModuleConfig } from '../module-instance.js';
import { Runtime } from '../runtime.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Assert inbox manager exists and return it (narrows type). */
function getManager(runtime: Runtime): InboxManager {
	const mgr = runtime.getInboxManager();
	expect(mgr).not.toBeNull();
	return mgr as InboxManager;
}

function makeEvent(id: string, source = 'src'): OrgLoopEvent {
	return createTestEvent({
		source,
		type: 'resource.changed',
		payload: { issue: { number: 42 }, id },
	});
}

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

// ─── InMemoryInboxStore ──────────────────────────────────────────────────────

describe('InMemoryInboxStore', () => {
	it('enqueues and drains events in chronological order', async () => {
		const store = new InMemoryInboxStore();
		const e1 = makeEvent('1');
		const e2 = makeEvent('2');
		const e3 = makeEvent('3');

		await store.enqueue('session-a', e1, 60_000);
		await store.enqueue('session-a', e2, 60_000);
		await store.enqueue('session-a', e3, 60_000);

		const result = await store.drain('session-a', 100);
		expect(result.events).toHaveLength(3);
		expect(result.events[0].payload.id).toBe('1');
		expect(result.events[1].payload.id).toBe('2');
		expect(result.events[2].payload.id).toBe('3');
		expect(result.remaining).toBe(0);
		expect(result.continuation).toBeNull();
	});

	it('returns empty drain for unknown session key', async () => {
		const store = new InMemoryInboxStore();
		const result = await store.drain('unknown', 100);
		expect(result.events).toHaveLength(0);
		expect(result.remaining).toBe(0);
	});

	it('respects drain limit and returns continuation', async () => {
		const store = new InMemoryInboxStore();
		for (let i = 0; i < 5; i++) {
			await store.enqueue('s1', makeEvent(String(i)), 60_000);
		}

		const result = await store.drain('s1', 3);
		expect(result.events).toHaveLength(3);
		expect(result.remaining).toBe(2);
		expect(result.continuation).not.toBeNull();

		// Second drain gets the remaining
		const result2 = await store.drain('s1', 100);
		expect(result2.events).toHaveLength(2);
		expect(result2.remaining).toBe(0);
	});

	it('expires stale entries by TTL', async () => {
		const store = new InMemoryInboxStore();
		// Enqueue with a 1ms TTL
		await store.enqueue('s1', makeEvent('old'), 1);
		// Wait for expiry
		await new Promise((r) => setTimeout(r, 5));

		expect(await store.pending('s1')).toBe(0);

		const result = await store.drain('s1', 100);
		expect(result.events).toHaveLength(0);
	});

	it('expireStale removes expired entries across all keys', async () => {
		const store = new InMemoryInboxStore();
		await store.enqueue('s1', makeEvent('a'), 1);
		await store.enqueue('s2', makeEvent('b'), 1);
		await store.enqueue('s3', makeEvent('c'), 60_000); // This one stays

		await new Promise((r) => setTimeout(r, 5));

		const expired = await store.expireStale();
		expect(expired).toBe(2);

		expect(await store.pending('s1')).toBe(0);
		expect(await store.pending('s2')).toBe(0);
		expect(await store.pending('s3')).toBe(1);
	});

	it('concurrent drains return disjoint event sets', async () => {
		const store = new InMemoryInboxStore();
		for (let i = 0; i < 10; i++) {
			await store.enqueue('s1', makeEvent(String(i)), 60_000);
		}

		// Two concurrent drains with limit 5
		const [r1, r2] = await Promise.all([store.drain('s1', 5), store.drain('s1', 5)]);

		// Combined, they should have all 10 events with no duplicates
		const allIds = [...r1.events, ...r2.events].map((e) => e.payload.id);
		expect(allIds).toHaveLength(10);
		expect(new Set(allIds).size).toBe(10);
	});

	it('pending() filters out expired events', async () => {
		const store = new InMemoryInboxStore();
		await store.enqueue('s1', makeEvent('live'), 60_000);
		await store.enqueue('s1', makeEvent('dead'), 1);

		await new Promise((r) => setTimeout(r, 5));

		expect(await store.pending('s1')).toBe(1);
	});

	it('close() clears all data', async () => {
		const store = new InMemoryInboxStore();
		await store.enqueue('s1', makeEvent('a'), 60_000);
		await store.close();
		expect(await store.pending('s1')).toBe(0);
	});
});

// ─── InboxManager ────────────────────────────────────────────────────────────

describe('InboxManager', () => {
	it('sends notification on first enqueue, suppresses on subsequent', async () => {
		const notifications: Array<{ key: string; count: number }> = [];
		const manager = new InboxManager({ defaultTtl: '1h' });
		manager.onNotify = async (key, count) => {
			notifications.push({ key, count });
		};

		const config: InboxConfig = { inbox: true, session_key: 'sess-1' };
		await manager.enqueue('sess-1', makeEvent('1'), config);
		await manager.enqueue('sess-1', makeEvent('2'), config);
		await manager.enqueue('sess-1', makeEvent('3'), config);

		// Only one notification despite three enqueues
		expect(notifications).toHaveLength(1);
		expect(notifications[0].key).toBe('sess-1');

		await manager.close();
	});

	it('re-notifies after drain if new events arrived', async () => {
		const notifications: Array<{ key: string; count: number }> = [];
		const manager = new InboxManager({ defaultTtl: '1h' });
		manager.onNotify = async (key, count) => {
			notifications.push({ key, count });
		};

		const config: InboxConfig = { inbox: true, session_key: 'sess-1' };
		await manager.enqueue('sess-1', makeEvent('1'), config);
		expect(notifications).toHaveLength(1);

		// Enqueue more while "notification is pending"
		await manager.enqueue('sess-1', makeEvent('2'), config);

		// Drain — this clears the flag and re-notifies since event '2' remains
		// First drain should return event '1' and '2'
		const result = await manager.drain('sess-1');
		expect(result.events).toHaveLength(2);

		// No re-notification because all events were drained
		expect(notifications).toHaveLength(1);

		// Enqueue a new event — should trigger a fresh notification
		await manager.enqueue('sess-1', makeEvent('3'), config);
		expect(notifications).toHaveLength(2);

		await manager.close();
	});

	it('drain returns empty array for stale/empty inbox', async () => {
		const manager = new InboxManager({ defaultTtl: '1h' });
		const result = await manager.drain('nonexistent');
		expect(result.events).toHaveLength(0);
		expect(result.remaining).toBe(0);
		await manager.close();
	});

	it('uses per-route TTL from config', async () => {
		const manager = new InboxManager({ defaultTtl: '1h' });

		const config: InboxConfig = { inbox: true, session_key: 's1', inbox_ttl: '1ms' };
		await manager.enqueue('s1', makeEvent('1'), config);

		await new Promise((r) => setTimeout(r, 5));

		const result = await manager.drain('s1');
		expect(result.events).toHaveLength(0);

		await manager.close();
	});

	it('notification failure is non-fatal and clears pending flag', async () => {
		const manager = new InboxManager({ defaultTtl: '1h' });
		manager.onNotify = async () => {
			throw new Error('Notification service down');
		};

		const config: InboxConfig = { inbox: true, session_key: 's1' };

		// Should not throw
		await manager.enqueue('s1', makeEvent('1'), config);

		// Events are still in the inbox and drainable
		const result = await manager.drain('s1');
		expect(result.events).toHaveLength(1);

		await manager.close();
	});

	it('handles multiple independent session keys', async () => {
		const notifications: string[] = [];
		const manager = new InboxManager({ defaultTtl: '1h' });
		manager.onNotify = async (key) => {
			notifications.push(key);
		};

		const config = (key: string): InboxConfig => ({
			inbox: true,
			session_key: key,
		});

		await manager.enqueue('a', makeEvent('a1'), config('a'));
		await manager.enqueue('b', makeEvent('b1'), config('b'));
		await manager.enqueue('c', makeEvent('c1'), config('c'));

		// Each session key gets its own notification
		expect(notifications).toHaveLength(3);
		expect(notifications).toContain('a');
		expect(notifications).toContain('b');
		expect(notifications).toContain('c');

		// Drains are independent
		const rA = await manager.drain('a');
		expect(rA.events).toHaveLength(1);
		expect(rA.events[0].payload.id).toBe('a1');

		const rB = await manager.drain('b');
		expect(rB.events).toHaveLength(1);
		expect(rB.events[0].payload.id).toBe('b1');

		await manager.close();
	});

	it('large batch pagination with continuation', async () => {
		const manager = new InboxManager({ defaultTtl: '1h', defaultMaxBatch: 50 });

		const config: InboxConfig = { inbox: true, session_key: 's1' };
		for (let i = 0; i < 200; i++) {
			await manager.enqueue('s1', makeEvent(String(i)), config);
		}

		// First drain returns max batch
		const r1 = await manager.drain('s1');
		expect(r1.events).toHaveLength(50);
		expect(r1.remaining).toBe(150);
		expect(r1.continuation).not.toBeNull();

		// Second drain with explicit limit
		const r2 = await manager.drain('s1', 150);
		expect(r2.events).toHaveLength(150);
		expect(r2.remaining).toBe(0);
		expect(r2.continuation).toBeNull();

		await manager.close();
	});

	it('startCleanup and stopCleanup manage timer lifecycle', async () => {
		const manager = new InboxManager({
			defaultTtl: '1h',
			cleanupInterval: '100ms',
		});

		manager.startCleanup();
		// Calling twice is idempotent
		manager.startCleanup();

		manager.stopCleanup();
		// Calling twice is idempotent
		manager.stopCleanup();

		await manager.close();
	});
});

// ─── Runtime Integration ─────────────────────────────────────────────────────

describe('Runtime inbox integration', () => {
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

	it('routes events through inbox when inbox: true in config', async () => {
		runtime = new Runtime({
			bus: new InMemoryBus(),
			inbox: {},
		});
		await runtime.start();

		const source = new MockSource('src');
		const actor = new MockActor('act');

		const config = makeModuleConfig('m', {
			sources: [{ id: 'src', connector: 'mock', config: {}, poll: { interval: '5m' } }],
			actors: [{ id: 'act', connector: 'mock', config: {} }],
			routes: [
				{
					name: 'inbox-route',
					when: { source: 'src', events: ['resource.changed'] },
					then: {
						actor: 'act',
						config: {
							inbox: true,
							session_key: 'test:{{payload.issue.number}}',
						},
					},
				},
			],
		});

		await runtime.loadModule(config, {
			sources: new Map([['src', source]]),
			actors: new Map([['act', actor]]),
		});

		// Inject events
		const e1 = makeEvent('1');
		const e2 = makeEvent('2');
		await runtime.inject(e1, 'm');
		await runtime.inject(e2, 'm');

		// Actor should NOT receive direct delivery (events go to inbox)
		expect(actor.delivered).toHaveLength(0);

		// Events should be drainable from inbox
		const manager = getManager(runtime);
		const result = await manager.drain('test:42');
		expect(result.events).toHaveLength(2);
		expect(result.events[0].payload.id).toBe('1');
		expect(result.events[1].payload.id).toBe('2');
	});

	it('delivers directly when inbox is not configured', async () => {
		runtime = new Runtime({
			bus: new InMemoryBus(),
			inbox: {},
		});
		await runtime.start();

		const source = new MockSource('src');
		const actor = new MockActor('act');

		const config = makeModuleConfig('m', {
			sources: [{ id: 'src', connector: 'mock', config: {}, poll: { interval: '5m' } }],
			actors: [{ id: 'act', connector: 'mock', config: {} }],
			routes: [
				{
					name: 'direct-route',
					when: { source: 'src', events: ['resource.changed'] },
					then: { actor: 'act' },
				},
			],
		});

		await runtime.loadModule(config, {
			sources: new Map([['src', source]]),
			actors: new Map([['act', actor]]),
		});

		await runtime.inject(makeEvent('1'), 'm');

		// Direct delivery — actor receives event
		expect(actor.delivered).toHaveLength(1);
	});

	it('delivers directly when runtime has no inbox option', async () => {
		runtime = new Runtime({ bus: new InMemoryBus() });
		await runtime.start();

		const source = new MockSource('src');
		const actor = new MockActor('act');

		const config = makeModuleConfig('m', {
			sources: [{ id: 'src', connector: 'mock', config: {}, poll: { interval: '5m' } }],
			actors: [{ id: 'act', connector: 'mock', config: {} }],
			routes: [
				{
					name: 'no-inbox-route',
					when: { source: 'src', events: ['resource.changed'] },
					then: {
						actor: 'act',
						config: {
							inbox: true,
							session_key: 'test:{{payload.issue.number}}',
						},
					},
				},
			],
		});

		await runtime.loadModule(config, {
			sources: new Map([['src', source]]),
			actors: new Map([['act', actor]]),
		});

		await runtime.inject(makeEvent('1'), 'm');

		// Without inbox option, delivery goes direct even with inbox: true in route
		expect(actor.delivered).toHaveLength(1);
	});

	it('inbox notification callback fires for first event only', async () => {
		const notifications: Array<{ key: string; count: number }> = [];

		runtime = new Runtime({
			bus: new InMemoryBus(),
			inbox: {},
		});
		await runtime.start();

		const manager = getManager(runtime);
		manager.onNotify = async (key, count) => {
			notifications.push({ key, count });
		};

		const source = new MockSource('src');
		const actor = new MockActor('act');

		const config = makeModuleConfig('m', {
			sources: [{ id: 'src', connector: 'mock', config: {}, poll: { interval: '5m' } }],
			actors: [{ id: 'act', connector: 'mock', config: {} }],
			routes: [
				{
					name: 'inbox-route',
					when: { source: 'src', events: ['resource.changed'] },
					then: {
						actor: 'act',
						config: {
							inbox: true,
							session_key: 'key:{{payload.issue.number}}',
						},
					},
				},
			],
		});

		await runtime.loadModule(config, {
			sources: new Map([['src', source]]),
			actors: new Map([['act', actor]]),
		});

		// Inject 5 events
		for (let i = 0; i < 5; i++) {
			await runtime.inject(makeEvent(String(i)), 'm');
		}

		// Only one notification despite 5 events
		expect(notifications).toHaveLength(1);
		expect(notifications[0].key).toBe('key:42');

		// Drain all
		const result = await manager.drain('key:42');
		expect(result.events).toHaveLength(5);

		// After drain, new event triggers new notification
		await runtime.inject(makeEvent('5'), 'm');
		expect(notifications).toHaveLength(2);
	});

	it('getInboxManager returns null when inbox not configured', () => {
		runtime = new Runtime({ bus: new InMemoryBus() });
		expect(runtime.getInboxManager()).toBeNull();
	});

	it('mixed inbox and direct routes work independently', async () => {
		runtime = new Runtime({
			bus: new InMemoryBus(),
			inbox: {},
		});
		await runtime.start();

		const source = new MockSource('src');
		const inboxActor = new MockActor('inbox-act');
		const directActor = new MockActor('direct-act');

		const config = makeModuleConfig('m', {
			sources: [{ id: 'src', connector: 'mock', config: {}, poll: { interval: '5m' } }],
			actors: [
				{ id: 'inbox-act', connector: 'mock', config: {} },
				{ id: 'direct-act', connector: 'mock', config: {} },
			],
			routes: [
				{
					name: 'inbox-route',
					when: { source: 'src', events: ['resource.changed'] },
					then: {
						actor: 'inbox-act',
						config: {
							inbox: true,
							session_key: 'inbox:{{payload.issue.number}}',
						},
					},
				},
				{
					name: 'direct-route',
					when: { source: 'src', events: ['resource.changed'] },
					then: { actor: 'direct-act' },
				},
			],
		});

		await runtime.loadModule(config, {
			sources: new Map([['src', source]]),
			actors: new Map([
				['inbox-act', inboxActor],
				['direct-act', directActor],
			]),
		});

		await runtime.inject(makeEvent('1'), 'm');

		// Direct actor receives event immediately
		expect(directActor.delivered).toHaveLength(1);

		// Inbox actor does NOT receive direct delivery
		expect(inboxActor.delivered).toHaveLength(0);

		// But inbox has the event
		const manager = getManager(runtime);
		const result = await manager.drain('inbox:42');
		expect(result.events).toHaveLength(1);
	});
});
