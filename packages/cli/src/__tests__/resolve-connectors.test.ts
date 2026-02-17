import type { ConnectorRegistration, OrgLoopConfig } from '@orgloop/sdk';
import { MockActor, MockSource } from '@orgloop/sdk';
import { describe, expect, it } from 'vitest';
import { resolveConnectors } from '../resolve-connectors.js';

function makeConfig(overrides?: Partial<OrgLoopConfig>): OrgLoopConfig {
	return {
		project: { name: 'test' },
		sources: [
			{
				id: 'my-source',
				connector: '@orgloop/connector-mock-source',
				config: {},
				poll: { interval: '5m' },
			},
		],
		actors: [
			{
				id: 'my-actor',
				connector: '@orgloop/connector-mock-actor',
				config: {},
			},
		],
		routes: [],
		transforms: [],
		loggers: [],
		...overrides,
	};
}

function mockImportFn(registrations: Record<string, ConnectorRegistration>) {
	return async (specifier: string) => {
		const reg = registrations[specifier];
		if (!reg) {
			throw new Error(`Module not found: ${specifier}`);
		}
		return { default: () => reg };
	};
}

describe('resolveConnectors', () => {
	it('populates sources Map correctly', async () => {
		const importFn = mockImportFn({
			'@orgloop/connector-mock-source': {
				id: 'mock-source',
				source: MockSource,
			},
			'@orgloop/connector-mock-actor': {
				id: 'mock-actor',
				target: MockActor,
			},
		});

		const { sources } = await resolveConnectors(makeConfig(), importFn);

		expect(sources.size).toBe(1);
		expect(sources.has('my-source')).toBe(true);
		expect(sources.get('my-source')).toBeInstanceOf(MockSource);
	});

	it('populates actors Map correctly', async () => {
		const importFn = mockImportFn({
			'@orgloop/connector-mock-source': {
				id: 'mock-source',
				source: MockSource,
			},
			'@orgloop/connector-mock-actor': {
				id: 'mock-actor',
				target: MockActor,
			},
		});

		const { actors } = await resolveConnectors(makeConfig(), importFn);

		expect(actors.size).toBe(1);
		expect(actors.has('my-actor')).toBe(true);
		expect(actors.get('my-actor')).toBeInstanceOf(MockActor);
	});

	it('throws if connector missing required source capability', async () => {
		const importFn = mockImportFn({
			'@orgloop/connector-mock-source': {
				id: 'mock-source',
				// No source class provided
				target: MockActor,
			},
			'@orgloop/connector-mock-actor': {
				id: 'mock-actor',
				target: MockActor,
			},
		});

		await expect(resolveConnectors(makeConfig(), importFn)).rejects.toThrow(
			/does not provide a source/,
		);
	});

	it('throws if connector missing required target capability', async () => {
		const importFn = mockImportFn({
			'@orgloop/connector-mock-source': {
				id: 'mock-source',
				source: MockSource,
			},
			'@orgloop/connector-mock-actor': {
				id: 'mock-actor',
				// No target class provided
				source: MockSource,
			},
		});

		await expect(resolveConnectors(makeConfig(), importFn)).rejects.toThrow(
			/does not provide a target/,
		);
	});

	it('throws with install hint if connector import fails', async () => {
		const importFn = async () => {
			throw new Error('Cannot find module');
		};

		await expect(
			resolveConnectors(
				makeConfig(),
				importFn as unknown as Parameters<typeof resolveConnectors>[1],
			),
		).rejects.toThrow(/npm install/);
	});

	it('handles config with no sources or actors', async () => {
		const config = makeConfig({
			sources: [],
			actors: [],
		});

		const { sources, actors } = await resolveConnectors(config, mockImportFn({}));

		expect(sources.size).toBe(0);
		expect(actors.size).toBe(0);
	});

	it('reuses connector registration for same package', async () => {
		let importCount = 0;
		const importFn = async (specifier: string) => {
			importCount++;
			if (specifier === '@orgloop/connector-webhook') {
				return {
					default: (): ConnectorRegistration => ({
						id: 'webhook',
						source: MockSource,
						target: MockActor,
					}),
				};
			}
			throw new Error(`Unknown: ${specifier}`);
		};

		const config = makeConfig({
			sources: [{ id: 'src1', connector: '@orgloop/connector-webhook', config: {} }],
			actors: [{ id: 'act1', connector: '@orgloop/connector-webhook', config: {} }],
		});

		const { sources, actors } = await resolveConnectors(config, importFn);

		// Same package should only be imported once
		expect(importCount).toBe(1);
		expect(sources.size).toBe(1);
		expect(actors.size).toBe(1);
	});
});
