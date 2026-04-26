/**
 * Regression tests for validateProject() and connector configSchema validation.
 *
 * The bug being guarded: validateInstanceConfigs() looked up registrations
 * by connectorKey(packageString) but resolvePlugins stores them by
 * connectorKey(reg.id) and connectorKey(instanceId). Lookup mismatch ⇒
 * connector configSchema validation silently no-oped.
 */

import type { ConnectorRegistration, OrgLoopConfig, PluginRegistration } from '@orgloop/sdk';
import { describe, expect, it } from 'vitest';
import { connectorKey, validateProject } from '../validate.js';

function makeRegistration(id: string): ConnectorRegistration {
	return {
		id,
		source: class {
			async init(): Promise<void> {}
			async poll(): Promise<{ events: []; checkpoint: string }> {
				return { events: [], checkpoint: '' };
			}
			async shutdown(): Promise<void> {}
		} as unknown as ConnectorRegistration['source'],
		configSchema: {
			type: 'object',
			required: ['secret'],
			properties: {
				secret: { type: 'string' },
			},
		},
	};
}

function makeConfig(overrides?: Partial<OrgLoopConfig>): OrgLoopConfig {
	return {
		project: { name: 'test' },
		sources: [],
		actors: [],
		routes: [],
		transforms: [],
		loggers: [],
		...overrides,
	};
}

describe('validateProject — connector configSchema validation', () => {
	it('reports connector-config error when source config violates configSchema', async () => {
		const reg = makeRegistration('test-conn');
		const config = makeConfig({
			sources: [
				{
					id: 'my-source',
					connector: '@orgloop/connector-test-conn',
					config: {}, // missing required `secret`
				},
			],
		});
		const registrations = new Map<string, PluginRegistration>();
		// resolvePlugins stores keys by registration id and per-instance id
		registrations.set(connectorKey(reg.id), reg);
		registrations.set(connectorKey('my-source'), reg);

		const result = await validateProject({
			config,
			projectDir: process.cwd(),
			registrations,
		});

		const connectorErrors = result.errors.filter((e) => e.scope === 'connector-config');
		expect(connectorErrors.length).toBeGreaterThan(0);
		expect(connectorErrors[0].path).toBe('sources/my-source');
	});

	it('reports connector-config error when actor config violates configSchema', async () => {
		const reg = makeRegistration('test-conn');
		const config = makeConfig({
			actors: [
				{
					id: 'my-actor',
					connector: '@orgloop/connector-test-conn',
					config: {}, // missing required `secret`
				},
			],
		});
		const registrations = new Map<string, PluginRegistration>();
		registrations.set(connectorKey(reg.id), reg);
		registrations.set(connectorKey('my-actor'), reg);

		const result = await validateProject({
			config,
			projectDir: process.cwd(),
			registrations,
		});

		const connectorErrors = result.errors.filter((e) => e.scope === 'connector-config');
		expect(connectorErrors.length).toBeGreaterThan(0);
		expect(connectorErrors[0].path).toBe('actors/my-actor');
	});

	it('passes when source config satisfies configSchema', async () => {
		const reg = makeRegistration('test-conn');
		const config = makeConfig({
			sources: [
				{
					id: 'my-source',
					connector: '@orgloop/connector-test-conn',
					config: { secret: 'shh' },
				},
			],
		});
		const registrations = new Map<string, PluginRegistration>();
		registrations.set(connectorKey(reg.id), reg);
		registrations.set(connectorKey('my-source'), reg);

		const result = await validateProject({
			config,
			projectDir: process.cwd(),
			registrations,
		});

		expect(result.errors.filter((e) => e.scope === 'connector-config')).toEqual([]);
	});
});
