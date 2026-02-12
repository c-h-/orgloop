import { MockActor, MockLogger, MockSource, MockTransform } from '@orgloop/sdk';
import { describe, expect, it } from 'vitest';
import { ModuleInstance } from '../module-instance.js';
import type { ModuleConfig } from '../module-instance.js';
import { ModuleRegistry } from '../registry.js';
import { InMemoryCheckpointStore } from '../store.js';

function createMinimalModule(name: string): ModuleInstance {
	const config: ModuleConfig = {
		name,
		sources: [],
		actors: [],
		routes: [],
		transforms: [],
		loggers: [],
	};
	return new ModuleInstance(config, {
		sources: new Map(),
		actors: new Map(),
		transforms: new Map(),
		loggers: new Map(),
		checkpointStore: new InMemoryCheckpointStore(),
	});
}

describe('ModuleRegistry', () => {
	it('registers and retrieves a module by name', () => {
		const registry = new ModuleRegistry();
		const mod = createMinimalModule('test-module');

		registry.register(mod);

		expect(registry.get('test-module')).toBe(mod);
	});

	it('throws ModuleConflictError on duplicate name registration', () => {
		const registry = new ModuleRegistry();
		const mod1 = createMinimalModule('dup');
		const mod2 = createMinimalModule('dup');

		registry.register(mod1);

		expect(() => registry.register(mod2)).toThrowError('Module "dup" is already loaded');
	});

	it('throws error with correct name property', () => {
		const registry = new ModuleRegistry();
		const mod1 = createMinimalModule('conflict');
		const mod2 = createMinimalModule('conflict');

		registry.register(mod1);

		try {
			registry.register(mod2);
			expect.unreachable('should have thrown');
		} catch (err) {
			expect((err as Error).name).toBe('ModuleConflictError');
		}
	});

	it('unregisters a module and returns it', () => {
		const registry = new ModuleRegistry();
		const mod = createMinimalModule('removable');

		registry.register(mod);
		const removed = registry.unregister('removable');

		expect(removed).toBe(mod);
		expect(registry.has('removable')).toBe(false);
	});

	it('returns undefined when unregistering non-existent module', () => {
		const registry = new ModuleRegistry();

		expect(registry.unregister('ghost')).toBeUndefined();
	});

	it('lists all registered modules', () => {
		const registry = new ModuleRegistry();
		const a = createMinimalModule('mod-a');
		const b = createMinimalModule('mod-b');
		const c = createMinimalModule('mod-c');

		registry.register(a);
		registry.register(b);
		registry.register(c);

		const list = registry.list();
		expect(list).toHaveLength(3);
		expect(list).toContain(a);
		expect(list).toContain(b);
		expect(list).toContain(c);
	});

	it('has() returns true for registered, false for unknown', () => {
		const registry = new ModuleRegistry();
		const mod = createMinimalModule('exists');

		registry.register(mod);

		expect(registry.has('exists')).toBe(true);
		expect(registry.has('nope')).toBe(false);
	});

	it('size getter reflects current count', () => {
		const registry = new ModuleRegistry();
		expect(registry.size).toBe(0);

		registry.register(createMinimalModule('one'));
		expect(registry.size).toBe(1);

		registry.register(createMinimalModule('two'));
		expect(registry.size).toBe(2);

		registry.unregister('one');
		expect(registry.size).toBe(1);
	});
});
