/**
 * Tests for the Runtime class — multi-module lifecycle management.
 */

import { MockActor, MockLogger, MockSource, MockTransform, createTestEvent } from '@orgloop/sdk';
import type { ModuleStatus, OrgLoopEvent } from '@orgloop/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryBus } from '../bus.js';
import type { ModuleConfig } from '../module-instance.js';
import { Runtime } from '../runtime.js';
import { InMemoryCheckpointStore } from '../store.js';

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
