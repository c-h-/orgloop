import { MockActor, MockLogger, MockSource, MockTransform } from '@orgloop/sdk';
import { describe, expect, it } from 'vitest';
import { ModuleInstance } from '../module-instance.js';
import type { ModuleConfig } from '../module-instance.js';
import { InMemoryCheckpointStore } from '../store.js';

function makeConfig(overrides?: Partial<ModuleConfig>): ModuleConfig {
	return {
		name: 'test-module',
		sources: [
			{
				id: 'src-1',
				connector: 'mock',
				config: { url: 'https://example.com' },
				poll: { interval: '5m' },
			},
		],
		actors: [
			{
				id: 'act-1',
				connector: 'mock',
				config: { target: 'https://example.com/hook' },
			},
		],
		routes: [
			{
				name: 'route-1',
				when: { source: 'src-1', events: ['resource.changed'] },
				then: { actor: 'act-1' },
			},
		],
		transforms: [{ name: 'tx-1', type: 'package' as const, config: { mode: 'test' } }],
		loggers: [{ name: 'log-1', type: 'mock', config: { level: 'debug' } }],
		...overrides,
	};
}

function createInstance(
	configOverrides?: Partial<ModuleConfig>,
	optionOverrides?: Partial<{
		sources: Map<string, MockSource>;
		actors: Map<string, MockActor>;
		transforms: Map<string, MockTransform>;
		loggers: Map<string, MockLogger>;
		checkpointStore: InMemoryCheckpointStore;
	}>,
) {
	const source = new MockSource('src-1');
	const actor = new MockActor('act-1');
	const transform = new MockTransform('tx-1');
	const logger = new MockLogger('log-1');
	const checkpointStore = new InMemoryCheckpointStore();

	const config = makeConfig(configOverrides);
	const instance = new ModuleInstance(config, {
		sources: optionOverrides?.sources ?? new Map([['src-1', source]]),
		actors: optionOverrides?.actors ?? new Map([['act-1', actor]]),
		transforms: optionOverrides?.transforms ?? new Map([['tx-1', transform]]),
		loggers: optionOverrides?.loggers ?? new Map([['log-1', logger]]),
		checkpointStore: optionOverrides?.checkpointStore ?? checkpointStore,
	});

	return { instance, source, actor, transform, logger, checkpointStore };
}

describe('ModuleInstance', () => {
	it('sets name and initial state to loading', () => {
		const { instance } = createInstance();

		expect(instance.name).toBe('test-module');
		expect(instance.getState()).toBe('loading');
	});

	it('initialize() calls init on sources, actors, transforms, and loggers', async () => {
		const { instance, source, actor, transform, logger } = createInstance();

		await instance.initialize();

		expect(source.initialized).toBe(true);
		expect(actor.initialized).toBe(true);
		expect(transform.initialized).toBe(true);
		expect(logger.initialized).toBe(true);
	});

	it('activate() sets state to active and records start time', () => {
		const { instance } = createInstance();

		const before = Date.now();
		instance.activate();
		const after = Date.now();

		expect(instance.getState()).toBe('active');
		// status().uptime_ms should be non-negative
		const st = instance.status();
		expect(st.uptime_ms).toBeGreaterThanOrEqual(0);
		expect(st.uptime_ms).toBeLessThanOrEqual(after - before + 10);
	});

	it('deactivate() sets state to unloading', () => {
		const { instance } = createInstance();

		instance.activate();
		instance.deactivate();

		expect(instance.getState()).toBe('unloading');
	});

	it('shutdown() calls shutdown on all connectors and sets state to removed', async () => {
		const { instance, source, actor, transform, logger } = createInstance();

		await instance.initialize();
		instance.activate();
		await instance.shutdown();

		expect(source.shutdownCalled).toBe(true);
		expect(actor.shutdownCalled).toBe(true);
		expect(transform.shutdownCalled).toBe(true);
		expect(logger.shutdownCalled).toBe(true);
		expect(instance.getState()).toBe('removed');
	});

	it('shutdown() is resilient to connector errors', async () => {
		const source = new MockSource('src-1');
		const actor = new MockActor('act-1');
		// Override shutdown to throw
		source.shutdown = async () => {
			throw new Error('source boom');
		};
		actor.shutdown = async () => {
			throw new Error('actor boom');
		};

		const config = makeConfig();
		const instance = new ModuleInstance(config, {
			sources: new Map([['src-1', source]]),
			actors: new Map([['act-1', actor]]),
			transforms: new Map(),
			loggers: new Map(),
			checkpointStore: new InMemoryCheckpointStore(),
		});

		// Should not throw
		await instance.shutdown();
		expect(instance.getState()).toBe('removed');
	});

	it('status() returns correct counts', () => {
		const { instance } = createInstance();

		const st = instance.status();

		expect(st.name).toBe('test-module');
		expect(st.state).toBe('loading');
		expect(st.sources).toBe(1);
		expect(st.actors).toBe(1);
		expect(st.routes).toBe(1);
		expect(st.uptime_ms).toBe(0);
	});

	it('status() includes health information', () => {
		const { instance } = createInstance();

		const st = instance.status();

		expect(st.health).toHaveLength(1);
		expect(st.health[0].sourceId).toBe('src-1');
		expect(st.health[0].status).toBe('healthy');
		expect(st.health[0].consecutiveErrors).toBe(0);
	});

	it('getContext() returns name and checkpoint store', () => {
		const checkpointStore = new InMemoryCheckpointStore();
		const { instance } = createInstance(undefined, { checkpointStore });

		const ctx = instance.getContext();

		expect(ctx.name).toBe('test-module');
		expect(ctx.checkpointStore).toBe(checkpointStore);
	});

	it('health states are initialized for all sources', () => {
		const config = makeConfig({
			sources: [
				{ id: 'src-a', connector: 'mock', config: {} },
				{ id: 'src-b', connector: 'mock', config: {} },
				{ id: 'src-c', connector: 'mock', config: {} },
			],
		});

		const instance = new ModuleInstance(config, {
			sources: new Map(),
			actors: new Map(),
			transforms: new Map(),
			loggers: new Map(),
			checkpointStore: new InMemoryCheckpointStore(),
		});

		const health = instance.getHealth();
		expect(health).toHaveLength(3);

		const ids = health.map((h) => h.sourceId).sort();
		expect(ids).toEqual(['src-a', 'src-b', 'src-c']);

		for (const h of health) {
			expect(h.status).toBe('healthy');
			expect(h.consecutiveErrors).toBe(0);
			expect(h.circuitOpen).toBe(false);
			expect(h.lastSuccessfulPoll).toBeNull();
		}
	});

	it('updateHealth() merges partial updates', () => {
		const { instance } = createInstance();

		instance.updateHealth('src-1', {
			consecutiveErrors: 3,
			status: 'degraded',
			lastError: 'timeout',
		});

		const h = instance.getHealthState('src-1');
		expect(h?.consecutiveErrors).toBe(3);
		expect(h?.status).toBe('degraded');
		expect(h?.lastError).toBe('timeout');
		// Other fields unchanged
		expect(h?.circuitOpen).toBe(false);
	});

	it('updateHealth() is a no-op for unknown source', () => {
		const { instance } = createInstance();

		// Should not throw
		instance.updateHealth('unknown-src', { consecutiveErrors: 5 });

		expect(instance.getHealthState('unknown-src')).toBeUndefined();
	});

	it('getRoutes() returns configured routes', () => {
		const { instance } = createInstance();

		const routes = instance.getRoutes();
		expect(routes).toHaveLength(1);
		expect(routes[0].name).toBe('route-1');
	});

	it('getSource() and getActor() return the correct connectors', () => {
		const { instance, source, actor } = createInstance();

		expect(instance.getSource('src-1')).toBe(source);
		expect(instance.getActor('act-1')).toBe(actor);
		expect(instance.getSource('unknown')).toBeUndefined();
		expect(instance.getActor('unknown')).toBeUndefined();
	});

	it('getTransform() and getTransformsMap() return transforms', () => {
		const { instance, transform } = createInstance();

		expect(instance.getTransform('tx-1')).toBe(transform);
		expect(instance.getTransform('unknown')).toBeUndefined();

		const map = instance.getTransformsMap();
		expect(map.size).toBe(1);
		expect(map.get('tx-1')).toBe(transform);
	});

	it('getLoggers() returns the loggers map', () => {
		const { instance, logger } = createInstance();

		const loggers = instance.getLoggers();
		expect(loggers.size).toBe(1);
		expect(loggers.get('log-1')).toBe(logger);
	});

	it('getCheckpointStore() returns the checkpoint store', () => {
		const checkpointStore = new InMemoryCheckpointStore();
		const { instance } = createInstance(undefined, { checkpointStore });

		expect(instance.getCheckpointStore()).toBe(checkpointStore);
	});
});
