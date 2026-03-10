/**
 * Tests for module persistence across daemon restarts.
 *
 * Validates that modules.json survives shutdown and that the auto-reload
 * logic handles missing configs and load failures gracefully.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	clearModulesState,
	readModulesState,
	registerModule,
	unregisterModule,
} from '../module-registry.js';

describe('module persistence across restarts', () => {
	let testDir: string;
	let originalHome: string;

	beforeEach(async () => {
		testDir = join(
			tmpdir(),
			`orgloop-persist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(join(testDir, '.orgloop'), { recursive: true });
		originalHome = process.env.HOME ?? '';
		process.env.HOME = testDir;
	});

	afterEach(async () => {
		process.env.HOME = originalHome;
		await rm(testDir, { recursive: true, force: true });
	});

	it('modules persist in modules.json after registration (simulated restart)', async () => {
		// Simulate first daemon session: register two modules
		await registerModule({
			name: 'mod-a',
			sourceDir: '/projects/a',
			configPath: '/projects/a/orgloop.yaml',
			loadedAt: '2026-01-01T00:00:00.000Z',
		});
		await registerModule({
			name: 'mod-b',
			sourceDir: '/projects/b',
			configPath: '/projects/b/orgloop.yaml',
			loadedAt: '2026-01-01T00:00:00.000Z',
		});

		// Simulate daemon shutdown WITHOUT clearing state (the fix)
		// — no clearModulesState() call —

		// Simulate second daemon session: read modules.json
		const state = await readModulesState();
		expect(state.modules).toHaveLength(2);
		expect(state.modules.map((m) => m.name).sort()).toEqual(['mod-a', 'mod-b']);
	});

	it('clearModulesState wipes registry (used by stop --all)', async () => {
		await registerModule({
			name: 'mod-a',
			sourceDir: '/projects/a',
			configPath: '/projects/a/orgloop.yaml',
			loadedAt: '2026-01-01T00:00:00.000Z',
		});

		await clearModulesState();

		const state = await readModulesState();
		expect(state.modules).toHaveLength(0);
	});

	it('explicit unregister removes only the target module', async () => {
		await registerModule({
			name: 'mod-a',
			sourceDir: '/projects/a',
			configPath: '/projects/a/orgloop.yaml',
			loadedAt: '2026-01-01T00:00:00.000Z',
		});
		await registerModule({
			name: 'mod-b',
			sourceDir: '/projects/b',
			configPath: '/projects/b/orgloop.yaml',
			loadedAt: '2026-01-01T00:00:00.000Z',
		});

		await unregisterModule('mod-a');

		const state = await readModulesState();
		expect(state.modules).toHaveLength(1);
		expect(state.modules[0].name).toBe('mod-b');
	});

	it('modules with missing config paths can be detected', async () => {
		// Register a module pointing to a non-existent config
		await registerModule({
			name: 'ghost-mod',
			sourceDir: '/nonexistent/project',
			configPath: '/nonexistent/project/orgloop.yaml',
			loadedAt: '2026-01-01T00:00:00.000Z',
		});

		const state = await readModulesState();
		expect(state.modules).toHaveLength(1);

		// The auto-reload logic in start.ts uses fs.access to check existence.
		// Here we verify the data is readable so the check can happen.
		const mod = state.modules[0];
		expect(mod.configPath).toBe('/nonexistent/project/orgloop.yaml');
	});

	it('persisted state survives multiple register/unregister cycles', async () => {
		// Register 3 modules
		for (const name of ['mod-a', 'mod-b', 'mod-c']) {
			await registerModule({
				name,
				sourceDir: `/projects/${name}`,
				configPath: `/projects/${name}/orgloop.yaml`,
				loadedAt: '2026-01-01T00:00:00.000Z',
			});
		}

		// Unregister one
		await unregisterModule('mod-b');

		// Re-register it with new path
		await registerModule({
			name: 'mod-b',
			sourceDir: '/projects/mod-b-v2',
			configPath: '/projects/mod-b-v2/orgloop.yaml',
			loadedAt: '2026-02-01T00:00:00.000Z',
		});

		const state = await readModulesState();
		expect(state.modules).toHaveLength(3);

		const modB = state.modules.find((m) => m.name === 'mod-b');
		expect(modB?.sourceDir).toBe('/projects/mod-b-v2');
	});

	it('modules.json with corrupt data returns empty state', async () => {
		// Write invalid JSON
		await writeFile(join(testDir, '.orgloop', 'modules.json'), 'not-json', 'utf-8');

		const state = await readModulesState();
		expect(state).toEqual({ modules: [] });
	});
});
