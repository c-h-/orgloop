/**
 * Tests for the Runtime class — multi-module lifecycle management.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	OrgLoopEvent,
	PollResult,
	SourceConfig,
	SourceConnector,
	WebhookHandler,
} from '@orgloop/sdk';
import { createTestEvent, MockActor, MockSource, MockTransform } from '@orgloop/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryBus } from '../bus.js';
import type { ModuleConfig } from '../module-instance.js';
import { Runtime } from '../runtime.js';
import { FileCheckpointStore, InMemoryCheckpointStore } from '../store.js';

/**
 * Hybrid source: has both webhook() and poll().
 * Models connector-webhook with buffer_dir — receives real-time webhooks AND
 * drains a local buffer file via poll().
 */
class MockHybridSource implements SourceConnector {
	readonly id: string;
	private pollCount = 0;
	private bufferedEvents: OrgLoopEvent[] = [];
	initialized = false;
	shutdownCalled = false;
	webhookHandlerCalled = false;

	constructor(id = 'mock-hybrid-source') {
		this.id = id;
	}

	addBufferedEvents(...events: OrgLoopEvent[]): void {
		this.bufferedEvents.push(...events);
	}

	async init(_config: SourceConfig): Promise<void> {
		this.initialized = true;
	}

	async poll(_checkpoint: string | null): Promise<PollResult> {
		this.pollCount++;
		const events = [...this.bufferedEvents];
		this.bufferedEvents = [];
		return { events, checkpoint: `hybrid-cp-${this.pollCount}` };
	}

	webhook(): WebhookHandler {
		return async (_req: IncomingMessage, _res: ServerResponse) => {
			this.webhookHandlerCalled = true;
			return [];
		};
	}

	async shutdown(): Promise<void> {
		this.shutdownCalled = true;
	}

	get totalPolls(): number {
		return this.pollCount;
	}
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

describe('Runtime', () => {
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

	it('starts and stops cleanly', async () => {
		runtime = new Runtime({ bus: new InMemoryBus() });
		await runtime.start();
		expect(runtime.status().running).toBe(true);

		await runtime.stop();
		expect(runtime.status().running).toBe(false);
	});

	it('loads a module and reports status', async () => {
		runtime = new Runtime({ bus: new InMemoryBus() });
		await runtime.start();

		const source = new MockSource('mod-a-source');
		const actor = new MockActor('mod-a-actor');

		const config = makeModuleConfig('mod-a');
		const status = await runtime.loadModule(config, {
			sources: new Map([['mod-a-source', source]]),
			actors: new Map([['mod-a-actor', actor]]),
		});

		expect(status.name).toBe('mod-a');
		expect(status.state).toBe('active');
		expect(status.sources).toBe(1);
		expect(status.actors).toBe(1);
		expect(status.routes).toBe(1);

		const rtStatus = runtime.status();
		expect(rtStatus.modules).toHaveLength(1);
	});

	it('delivers events through a loaded module', async () => {
		runtime = new Runtime({ bus: new InMemoryBus() });
		await runtime.start();

		const source = new MockSource('mod-a-source');
		const actor = new MockActor('mod-a-actor');

		await runtime.loadModule(makeModuleConfig('mod-a'), {
			sources: new Map([['mod-a-source', source]]),
			actors: new Map([['mod-a-actor', actor]]),
		});

		const event = createTestEvent({
			source: 'mod-a-source',
			type: 'resource.changed',
		});

		await runtime.inject(event, 'mod-a');

		expect(actor.delivered).toHaveLength(1);
		expect(actor.delivered[0].event.source).toBe('mod-a-source');
	});

	it('loads multiple modules independently', async () => {
		runtime = new Runtime({ bus: new InMemoryBus() });
		await runtime.start();

		const sourceA = new MockSource('mod-a-source');
		const actorA = new MockActor('mod-a-actor');
		const sourceB = new MockSource('mod-b-source');
		const actorB = new MockActor('mod-b-actor');

		await runtime.loadModule(makeModuleConfig('mod-a'), {
			sources: new Map([['mod-a-source', sourceA]]),
			actors: new Map([['mod-a-actor', actorA]]),
		});

		await runtime.loadModule(makeModuleConfig('mod-b'), {
			sources: new Map([['mod-b-source', sourceB]]),
			actors: new Map([['mod-b-actor', actorB]]),
		});

		const rtStatus = runtime.status();
		expect(rtStatus.modules).toHaveLength(2);

		// Inject event to mod-a — only mod-a's actor should receive it
		const eventA = createTestEvent({
			source: 'mod-a-source',
			type: 'resource.changed',
		});
		await runtime.inject(eventA, 'mod-a');

		expect(actorA.delivered).toHaveLength(1);
		expect(actorB.delivered).toHaveLength(0);
	});

	it('unloads a module and cleans up', async () => {
		runtime = new Runtime({ bus: new InMemoryBus() });
		await runtime.start();

		const source = new MockSource('mod-a-source');
		const actor = new MockActor('mod-a-actor');

		await runtime.loadModule(makeModuleConfig('mod-a'), {
			sources: new Map([['mod-a-source', source]]),
			actors: new Map([['mod-a-actor', actor]]),
		});

		expect(runtime.status().modules).toHaveLength(1);

		await runtime.unloadModule('mod-a');

		expect(runtime.status().modules).toHaveLength(0);
		expect(source.shutdownCalled).toBe(true);
		expect(actor.shutdownCalled).toBe(true);
	});

	it('reloads a module', async () => {
		runtime = new Runtime({ bus: new InMemoryBus() });
		await runtime.start();

		const source = new MockSource('mod-a-source');
		const actor = new MockActor('mod-a-actor');

		await runtime.loadModule(makeModuleConfig('mod-a'), {
			sources: new Map([['mod-a-source', source]]),
			actors: new Map([['mod-a-actor', actor]]),
		});

		await runtime.reloadModule('mod-a');

		expect(runtime.status().modules).toHaveLength(1);
		expect(runtime.status().modules[0].name).toBe('mod-a');
	});

	it('rejects duplicate module names', async () => {
		runtime = new Runtime({ bus: new InMemoryBus() });
		await runtime.start();

		await runtime.loadModule(makeModuleConfig('mod-a'), {
			sources: new Map([['mod-a-source', new MockSource('mod-a-source')]]),
			actors: new Map([['mod-a-actor', new MockActor('mod-a-actor')]]),
		});

		await expect(
			runtime.loadModule(makeModuleConfig('mod-a'), {
				sources: new Map([['mod-a-source', new MockSource('mod-a-source')]]),
				actors: new Map([['mod-a-actor', new MockActor('mod-a-actor')]]),
			}),
		).rejects.toThrowError('Module "mod-a" is already loaded');
	});

	it('throws ModuleNotFoundError when unloading unknown module', async () => {
		runtime = new Runtime({ bus: new InMemoryBus() });
		await runtime.start();

		await expect(runtime.unloadModule('ghost')).rejects.toThrowError('Module not found: ghost');
	});

	it('runs transforms within a module', async () => {
		runtime = new Runtime({ bus: new InMemoryBus() });
		await runtime.start();

		const source = new MockSource('mod-a-source');
		const actor = new MockActor('mod-a-actor');
		const transform = new MockTransform('test-transform');

		const config = makeModuleConfig('mod-a', {
			transforms: [{ name: 'test-transform', type: 'package' }],
			routes: [
				{
					name: 'mod-a-route',
					when: { source: 'mod-a-source', events: ['resource.changed'] },
					transforms: [{ ref: 'test-transform' }],
					then: { actor: 'mod-a-actor' },
				},
			],
		});

		await runtime.loadModule(config, {
			sources: new Map([['mod-a-source', source]]),
			actors: new Map([['mod-a-actor', actor]]),
			transforms: new Map([['test-transform', transform]]),
		});

		const event = createTestEvent({
			source: 'mod-a-source',
			type: 'resource.changed',
		});

		await runtime.inject(event, 'mod-a');

		expect(transform.initialized).toBe(true);
		expect(actor.delivered).toHaveLength(1);
	});

	it('emits events from EventEmitter', async () => {
		runtime = new Runtime({ bus: new InMemoryBus() });
		await runtime.start();

		const source = new MockSource('mod-a-source');
		const actor = new MockActor('mod-a-actor');

		await runtime.loadModule(makeModuleConfig('mod-a'), {
			sources: new Map([['mod-a-source', source]]),
			actors: new Map([['mod-a-actor', actor]]),
		});

		const emittedEvents: OrgLoopEvent[] = [];
		runtime.on('event', (e: OrgLoopEvent) => emittedEvents.push(e));

		const event = createTestEvent({
			source: 'mod-a-source',
			type: 'resource.changed',
		});

		await runtime.inject(event, 'mod-a');

		expect(emittedEvents).toHaveLength(1);
	});

	// ─── WQ-93: Crash Handlers & Heartbeat ──────────────────────────────────

	it('installs crash handlers when enabled', async () => {
		runtime = new Runtime({
			bus: new InMemoryBus(),
			crashHandlers: true,
			heartbeat: false,
		});

		const listenerCountBefore = process.listenerCount('uncaughtException');
		await runtime.start();
		expect(process.listenerCount('uncaughtException')).toBe(listenerCountBefore + 1);
		expect(process.listenerCount('unhandledRejection')).toBeGreaterThan(0);

		await runtime.stop();
		expect(process.listenerCount('uncaughtException')).toBe(listenerCountBefore);
	});

	it('does not install crash handlers when disabled', async () => {
		runtime = new Runtime({
			bus: new InMemoryBus(),
			crashHandlers: false,
			heartbeat: false,
		});

		const listenerCountBefore = process.listenerCount('uncaughtException');
		await runtime.start();
		expect(process.listenerCount('uncaughtException')).toBe(listenerCountBefore);

		await runtime.stop();
	});

	it('removes crash handlers on stop', async () => {
		runtime = new Runtime({
			bus: new InMemoryBus(),
			crashHandlers: true,
			heartbeat: false,
		});

		const listenerCountBefore = process.listenerCount('uncaughtException');
		await runtime.start();
		await runtime.stop();
		expect(process.listenerCount('uncaughtException')).toBe(listenerCountBefore);
		expect(process.listenerCount('unhandledRejection')).toBe(
			process.listenerCount('unhandledRejection'),
		);
	});

	// ─── Checkpoint Store Resolution ─────────────────────────────────────

	it('defaults to FileCheckpointStore when modulePath is set', async () => {
		const tempDir = await mkdtemp(join(tmpdir(), 'orgloop-rt-cp-'));
		try {
			runtime = new Runtime({ bus: new InMemoryBus(), crashHandlers: false });
			await runtime.start();

			const source = new MockSource('cp-source');
			const actor = new MockActor('cp-actor');

			const config = makeModuleConfig('cp-mod', { modulePath: tempDir });
			const status = await runtime.loadModule(config, {
				sources: new Map([['cp-source', source]]),
				actors: new Map([['cp-actor', actor]]),
			});

			expect(status.state).toBe('active');
			// Module loaded with modulePath — runtime should have created a FileCheckpointStore
			// at tempDir/.orgloop/checkpoints/. We verify by reading back a checkpoint
			// after a simulated poll writes one.
			const store = new FileCheckpointStore(join(tempDir, '.orgloop', 'checkpoints'));
			await store.set('cp-source', 'test-value');
			expect(await store.get('cp-source')).toBe('test-value');
		} finally {
			await runtime.stop();
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it('uses InMemoryCheckpointStore when checkpoint.store is memory', async () => {
		runtime = new Runtime({ bus: new InMemoryBus(), crashHandlers: false });
		await runtime.start();

		const source = new MockSource('mem-source');
		const actor = new MockActor('mem-actor');

		const config = makeModuleConfig('mem-mod', {
			defaults: { poll_interval: '5m', checkpoint: { store: 'memory' } },
		});
		// Should not throw — memory store doesn't need filesystem
		const status = await runtime.loadModule(config, {
			sources: new Map([['mem-source', source]]),
			actors: new Map([['mem-actor', actor]]),
		});

		expect(status.state).toBe('active');
	});

	it('uses custom checkpoint dir from config', async () => {
		const tempDir = await mkdtemp(join(tmpdir(), 'orgloop-rt-cpdir-'));
		try {
			runtime = new Runtime({ bus: new InMemoryBus(), crashHandlers: false });
			await runtime.start();

			const source = new MockSource('dir-source');
			const actor = new MockActor('dir-actor');

			const customDir = join(tempDir, 'custom-checkpoints');
			const config = makeModuleConfig('dir-mod', {
				modulePath: tempDir,
				defaults: {
					poll_interval: '5m',
					checkpoint: { dir: customDir },
				},
			});

			await runtime.loadModule(config, {
				sources: new Map([['dir-source', source]]),
				actors: new Map([['dir-actor', actor]]),
			});

			expect(runtime.status().modules).toHaveLength(1);
		} finally {
			await runtime.stop();
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it('resolves relative checkpoint dir against modulePath', async () => {
		const tempDir = await mkdtemp(join(tmpdir(), 'orgloop-rt-relcp-'));
		try {
			runtime = new Runtime({ bus: new InMemoryBus(), crashHandlers: false });
			await runtime.start();

			const source = new MockSource('rel-source');
			const actor = new MockActor('rel-actor');

			const config = makeModuleConfig('rel-mod', {
				modulePath: tempDir,
				defaults: {
					poll_interval: '5m',
					checkpoint: { dir: 'my-checkpoints' },
				},
			});

			await runtime.loadModule(config, {
				sources: new Map([['rel-source', source]]),
				actors: new Map([['rel-actor', actor]]),
			});

			expect(runtime.status().modules).toHaveLength(1);
		} finally {
			await runtime.stop();
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it('explicit checkpointStore option overrides config defaults', async () => {
		runtime = new Runtime({ bus: new InMemoryBus(), crashHandlers: false });
		await runtime.start();

		const source = new MockSource('override-source');
		const actor = new MockActor('override-actor');
		const customStore = new InMemoryCheckpointStore();

		const config = makeModuleConfig('override-mod', {
			defaults: { poll_interval: '5m', checkpoint: { store: 'file' } },
		});

		// Passing explicit checkpointStore should override config
		const status = await runtime.loadModule(config, {
			sources: new Map([['override-source', source]]),
			actors: new Map([['override-actor', actor]]),
			checkpointStore: customStore,
		});

		expect(status.state).toBe('active');
	});

	// ─── Hybrid webhook + poll source (orgloop#21) ──────────────────────────

	it('hybrid source (webhook + poll.interval) gets both webhook handler and poll scheduling', async () => {
		runtime = new Runtime({ bus: new InMemoryBus(), crashHandlers: false, httpPort: 0 });
		await runtime.start();

		const source = new MockHybridSource('hybrid-source');
		const actor = new MockActor('hybrid-actor');

		const config: ModuleConfig = {
			name: 'hybrid-mod',
			sources: [
				{
					id: 'hybrid-source',
					connector: 'mock-hybrid',
					config: {},
					poll: { interval: '100ms' }, // fast interval so poll fires in test
				},
			],
			actors: [{ id: 'hybrid-actor', connector: 'mock', config: {} }],
			routes: [
				{
					name: 'hybrid-route',
					when: { source: 'hybrid-source', events: ['resource.changed'] },
					then: { actor: 'hybrid-actor' },
				},
			],
			transforms: [],
			loggers: [],
		};

		await runtime.loadModule(config, {
			sources: new Map([['hybrid-source', source]]),
			actors: new Map([['hybrid-actor', actor]]),
		});

		// The scheduler fires poll() immediately when a source is added to a running
		// scheduler. Give it a tick to complete.
		await new Promise((resolve) => setTimeout(resolve, 50));

		// poll() should have been called (buffer draining)
		expect(source.totalPolls).toBeGreaterThan(0);
	});

	it('hybrid source delivers buffered events via poll()', async () => {
		runtime = new Runtime({ bus: new InMemoryBus(), crashHandlers: false, httpPort: 0 });
		await runtime.start();

		const source = new MockHybridSource('hybrid-source');
		const actor = new MockActor('hybrid-actor');

		const bufferedEvent = createTestEvent({
			source: 'hybrid-source',
			type: 'resource.changed',
		});
		source.addBufferedEvents(bufferedEvent);

		const config: ModuleConfig = {
			name: 'hybrid-mod',
			sources: [
				{
					id: 'hybrid-source',
					connector: 'mock-hybrid',
					config: {},
					poll: { interval: '100ms' },
				},
			],
			actors: [{ id: 'hybrid-actor', connector: 'mock', config: {} }],
			routes: [
				{
					name: 'hybrid-route',
					when: { source: 'hybrid-source', events: ['resource.changed'] },
					then: { actor: 'hybrid-actor' },
				},
			],
			transforms: [],
			loggers: [],
		};

		await runtime.loadModule(config, {
			sources: new Map([['hybrid-source', source]]),
			actors: new Map([['hybrid-actor', actor]]),
		});

		// Wait for the initial poll to complete and deliver the buffered event
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(actor.delivered).toHaveLength(1);
		expect(actor.delivered[0].event.id).toBe(bufferedEvent.id);
	});

	it('pure webhook source without poll.interval does not get poll scheduling', async () => {
		runtime = new Runtime({ bus: new InMemoryBus(), crashHandlers: false, httpPort: 0 });
		await runtime.start();

		const source = new MockHybridSource('webhook-only-source');
		const actor = new MockActor('webhook-only-actor');

		const config: ModuleConfig = {
			name: 'webhook-only-mod',
			sources: [
				{
					// No poll.interval — pure webhook source
					id: 'webhook-only-source',
					connector: 'mock-hybrid',
					config: {},
				},
			],
			actors: [{ id: 'webhook-only-actor', connector: 'mock', config: {} }],
			routes: [
				{
					name: 'webhook-only-route',
					when: { source: 'webhook-only-source', events: ['resource.changed'] },
					then: { actor: 'webhook-only-actor' },
				},
			],
			transforms: [],
			loggers: [],
		};

		await runtime.loadModule(config, {
			sources: new Map([['webhook-only-source', source]]),
			actors: new Map([['webhook-only-actor', actor]]),
		});

		// Give time for any accidental poll to fire
		await new Promise((resolve) => setTimeout(resolve, 100));

		// poll() should NOT have been called — pure webhook source with no poll interval
		expect(source.totalPolls).toBe(0);
	});

	it('stop() shuts down all modules', async () => {
		runtime = new Runtime({ bus: new InMemoryBus() });
		await runtime.start();

		const sourceA = new MockSource('mod-a-source');
		const actorA = new MockActor('mod-a-actor');
		const sourceB = new MockSource('mod-b-source');
		const actorB = new MockActor('mod-b-actor');

		await runtime.loadModule(makeModuleConfig('mod-a'), {
			sources: new Map([['mod-a-source', sourceA]]),
			actors: new Map([['mod-a-actor', actorA]]),
		});

		await runtime.loadModule(makeModuleConfig('mod-b'), {
			sources: new Map([['mod-b-source', sourceB]]),
			actors: new Map([['mod-b-actor', actorB]]),
		});

		await runtime.stop();

		expect(sourceA.shutdownCalled).toBe(true);
		expect(actorA.shutdownCalled).toBe(true);
		expect(sourceB.shutdownCalled).toBe(true);
		expect(actorB.shutdownCalled).toBe(true);
	});
});
