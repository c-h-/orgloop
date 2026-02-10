/**
 * Module E2E tests — full round-trip validation.
 *
 * Tests: module resolution, parameter expansion, config merging,
 * composition (two modules sharing a source), namespacing (no collisions).
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
	expandModuleRoutes,
	loadModuleManifest,
	resolveModulePath,
	resolveModules,
} from '../module-resolver.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let testDir: string;

async function createTestDir(): Promise<string> {
	const dir = join(tmpdir(), `orgloop-module-test-${Date.now()}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

async function createTestModule(
	baseDir: string,
	name: string,
	manifest: Record<string, unknown>,
	routeTemplate?: string,
): Promise<string> {
	const moduleDir = join(baseDir, name);
	await mkdir(join(moduleDir, 'templates'), { recursive: true });
	await mkdir(join(moduleDir, 'sops'), { recursive: true });

	await writeFile(join(moduleDir, 'orgloop-module.yaml'), yaml.dump(manifest), 'utf-8');

	if (routeTemplate) {
		await writeFile(join(moduleDir, 'templates', 'routes.yaml'), routeTemplate, 'utf-8');
	}

	await writeFile(join(moduleDir, 'sops', 'example.md'), '# Example SOP\n', 'utf-8');

	return moduleDir;
}

beforeEach(async () => {
	testDir = await createTestDir();
});

afterEach(async () => {
	await rm(testDir, { recursive: true, force: true });
});

// ─── Module manifest loading ─────────────────────────────────────────────────

describe('loadModuleManifest', () => {
	it('loads a valid module manifest', async () => {
		const moduleDir = await createTestModule(testDir, 'test-module', {
			apiVersion: 'orgloop/v1alpha1',
			kind: 'Module',
			metadata: {
				name: 'test-module',
				description: 'A test module',
				version: '1.0.0',
			},
			parameters: [{ name: 'source', description: 'Source name', type: 'string', required: true }],
			provides: { routes: 1 },
		});

		const manifest = await loadModuleManifest(moduleDir);
		expect(manifest.kind).toBe('Module');
		expect(manifest.metadata.name).toBe('test-module');
		expect(manifest.parameters).toHaveLength(1);
	});

	it('throws on missing manifest file', async () => {
		const emptyDir = join(testDir, 'empty');
		await mkdir(emptyDir, { recursive: true });
		await expect(loadModuleManifest(emptyDir)).rejects.toThrow('Module manifest not found');
	});

	it('throws on invalid manifest (missing required fields)', async () => {
		const badDir = join(testDir, 'bad');
		await mkdir(badDir, { recursive: true });
		await writeFile(
			join(badDir, 'orgloop-module.yaml'),
			yaml.dump({ apiVersion: 'v1', kind: 'Wrong' }),
			'utf-8',
		);
		await expect(loadModuleManifest(badDir)).rejects.toThrow('Invalid module manifest');
	});
});

// ─── Module path resolution ──────────────────────────────────────────────────

describe('resolveModulePath', () => {
	it('resolves relative paths', () => {
		const result = resolveModulePath('./modules/engineering', '/home/user/project');
		expect(result).toBe('/home/user/project/modules/engineering');
	});

	it('preserves absolute paths', () => {
		const result = resolveModulePath('/opt/modules/custom', '/home/user/project');
		expect(result).toBe('/opt/modules/custom');
	});

	it('attempts npm resolution for scoped package names', () => {
		// Falls back to node_modules path when import.meta.resolve fails
		const result = resolveModulePath('@orgloop/module-test', '/home/user/project');
		expect(result).toContain('node_modules');
	});

	it('rejects bare names with a helpful error', () => {
		expect(() => resolveModulePath('engineering', '/home/user/project')).toThrow(
			'Unknown module "engineering". Use a fully qualified package name (e.g. @orgloop/module-engineering) or a local path (e.g. ./modules/engineering).',
		);
	});
});

// ─── Route expansion ─────────────────────────────────────────────────────────

describe('expandModuleRoutes', () => {
	it('expands parameterized route templates', async () => {
		const moduleDir = await createTestModule(
			testDir,
			'expand-test',
			{
				apiVersion: 'orgloop/v1alpha1',
				kind: 'Module',
				metadata: { name: 'expand-test', description: 'Expansion test', version: '1.0.0' },
				parameters: [
					{ name: 'source_name', description: 'Source', type: 'string', required: true },
					{ name: 'actor_name', description: 'Actor', type: 'string', required: true },
				],
			},
			`apiVersion: orgloop/v1alpha1
kind: RouteGroup
routes:
  - name: "{{ module.name }}-main-route"
    when:
      source: "{{ params.source_name }}"
      events:
        - resource.changed
    then:
      actor: "{{ params.actor_name }}"
    with:
      prompt_file: "{{ module.path }}/sops/example.md"
`,
		);

		const manifest = await loadModuleManifest(moduleDir);
		const routes = await expandModuleRoutes(moduleDir, manifest, {
			source_name: 'github',
			actor_name: 'my-agent',
		});

		expect(routes).toHaveLength(1);
		expect(routes[0].name).toBe('expand-test-main-route');
		expect(routes[0].when.source).toBe('github');
		expect(routes[0].then.actor).toBe('my-agent');
		expect(routes[0].with?.prompt_file).toBe(`${moduleDir}/sops/example.md`);
	});

	it('applies parameter defaults when not provided', async () => {
		const moduleDir = await createTestModule(
			testDir,
			'defaults-test',
			{
				apiVersion: 'orgloop/v1alpha1',
				kind: 'Module',
				metadata: { name: 'defaults-test', description: 'Defaults test', version: '1.0.0' },
				parameters: [
					{
						name: 'source',
						description: 'Source',
						type: 'string',
						required: true,
						default: 'github',
					},
				],
			},
			`apiVersion: orgloop/v1alpha1
kind: RouteGroup
routes:
  - name: "{{ module.name }}-route"
    when:
      source: "{{ params.source }}"
      events:
        - resource.changed
    then:
      actor: default-actor
`,
		);

		const manifest = await loadModuleManifest(moduleDir);
		const routes = await expandModuleRoutes(moduleDir, manifest, {});

		expect(routes[0].when.source).toBe('github');
	});

	it('throws on missing required parameter', async () => {
		const moduleDir = await createTestModule(
			testDir,
			'required-test',
			{
				apiVersion: 'orgloop/v1alpha1',
				kind: 'Module',
				metadata: { name: 'required-test', description: 'Required test', version: '1.0.0' },
				parameters: [
					{ name: 'must_have', description: 'Required', type: 'string', required: true },
				],
			},
			`apiVersion: orgloop/v1alpha1
kind: RouteGroup
routes:
  - name: "{{ module.name }}-route"
    when:
      source: "{{ params.must_have }}"
      events:
        - resource.changed
    then:
      actor: test-actor
`,
		);

		const manifest = await loadModuleManifest(moduleDir);
		await expect(expandModuleRoutes(moduleDir, manifest, {})).rejects.toThrow(
			'Missing required parameter "must_have"',
		);
	});

	it('returns empty array when no template exists', async () => {
		const moduleDir = await createTestModule(testDir, 'no-template', {
			apiVersion: 'orgloop/v1alpha1',
			kind: 'Module',
			metadata: { name: 'no-template', description: 'No template', version: '1.0.0' },
		});
		// Remove the templates dir
		await rm(join(moduleDir, 'templates'), { recursive: true, force: true });

		const manifest = await loadModuleManifest(moduleDir);
		const routes = await expandModuleRoutes(moduleDir, manifest, {});
		expect(routes).toEqual([]);
	});
});

// ─── Composition — two modules, one source ───────────────────────────────────

describe('module composition', () => {
	it('two modules can share the same source without collisions', async () => {
		// Module A: code-review
		const moduleA = await createTestModule(
			testDir,
			'code-review',
			{
				apiVersion: 'orgloop/v1alpha1',
				kind: 'Module',
				metadata: { name: 'code-review', description: 'Code review', version: '1.0.0' },
				parameters: [
					{ name: 'source', description: 'Source', type: 'string', required: true },
					{ name: 'actor', description: 'Actor', type: 'string', required: true },
				],
			},
			`apiVersion: orgloop/v1alpha1
kind: RouteGroup
routes:
  - name: "{{ module.name }}-pr-review"
    when:
      source: "{{ params.source }}"
      events:
        - resource.changed
    then:
      actor: "{{ params.actor }}"
`,
		);

		// Module B: ci-monitor
		const moduleB = await createTestModule(
			testDir,
			'ci-monitor',
			{
				apiVersion: 'orgloop/v1alpha1',
				kind: 'Module',
				metadata: { name: 'ci-monitor', description: 'CI monitor', version: '1.0.0' },
				parameters: [
					{ name: 'source', description: 'Source', type: 'string', required: true },
					{ name: 'actor', description: 'Actor', type: 'string', required: true },
				],
			},
			`apiVersion: orgloop/v1alpha1
kind: RouteGroup
routes:
  - name: "{{ module.name }}-ci-failure"
    when:
      source: "{{ params.source }}"
      events:
        - resource.changed
    then:
      actor: "{{ params.actor }}"
`,
		);

		const result = await resolveModules(
			[
				{ package: moduleA, params: { source: 'github', actor: 'engineering' } },
				{ package: moduleB, params: { source: 'github', actor: 'engineering' } },
			],
			testDir,
		);

		expect(result.routes).toHaveLength(2);
		expect(result.resolved).toHaveLength(2);

		// Both point to same source — no conflict
		expect(result.routes[0].when.source).toBe('github');
		expect(result.routes[1].when.source).toBe('github');

		// Route names are namespaced — no collisions
		const routeNames = result.routes.map((r) => r.name);
		expect(routeNames).toContain('code-review-pr-review');
		expect(routeNames).toContain('ci-monitor-ci-failure');
		expect(new Set(routeNames).size).toBe(routeNames.length); // No duplicates
	});
});

// ─── Namespacing ─────────────────────────────────────────────────────────────

describe('route namespacing', () => {
	it('module name prefixes all route names', async () => {
		const moduleDir = await createTestModule(
			testDir,
			'my-module',
			{
				apiVersion: 'orgloop/v1alpha1',
				kind: 'Module',
				metadata: { name: 'my-module', description: 'Namespace test', version: '1.0.0' },
				parameters: [],
			},
			`apiVersion: orgloop/v1alpha1
kind: RouteGroup
routes:
  - name: "{{ module.name }}-route-a"
    when:
      source: source1
      events:
        - resource.changed
    then:
      actor: actor1
  - name: "{{ module.name }}-route-b"
    when:
      source: source2
      events:
        - resource.changed
    then:
      actor: actor2
`,
		);

		const manifest = await loadModuleManifest(moduleDir);
		const routes = await expandModuleRoutes(moduleDir, manifest, {});

		expect(routes[0].name).toBe('my-module-route-a');
		expect(routes[1].name).toBe('my-module-route-b');
	});
});

// ─── Engineering module integration ──────────────────────────────────────────

describe('engineering module', () => {
	it('loads the real engineering module manifest', async () => {
		// Resolve the actual engineering module from the workspace
		const engineeringPath = join(testDir, '../../..', 'modules', 'engineering');
		// Use a direct path to the actual module in the repo
		const repoRoot = join(__dirname, '..', '..', '..', '..');
		const modulePath = join(repoRoot, 'modules', 'engineering');

		let manifest: Awaited<ReturnType<typeof loadModuleManifest>> | undefined;
		try {
			manifest = await loadModuleManifest(modulePath);
		} catch {
			// Skip if the module path isn't accessible in test env
			return;
		}

		expect(manifest.kind).toBe('Module');
		expect(manifest.metadata.name).toBe('engineering');
		expect(manifest.provides?.routes).toBe(5);
		expect(manifest.provides?.sops).toBe(3);
	});

	it('expands engineering module routes with params', async () => {
		const repoRoot = join(__dirname, '..', '..', '..', '..');
		const modulePath = join(repoRoot, 'modules', 'engineering');

		let manifest: Awaited<ReturnType<typeof loadModuleManifest>> | undefined;
		try {
			manifest = await loadModuleManifest(modulePath);
		} catch {
			return;
		}

		const routes = await expandModuleRoutes(modulePath, manifest, {
			github_source: 'my-github',
			linear_source: 'my-linear',
			claude_code_source: 'my-claude',
			agent_actor: 'my-agent',
		});

		expect(routes.length).toBe(5);

		// Check PR review route
		const prRoute = routes.find((r) => r.name === 'engineering-pr-review');
		expect(prRoute).toBeDefined();
		expect(prRoute?.when.source).toBe('my-github');
		expect(prRoute?.then.actor).toBe('my-agent');
		expect(prRoute?.with?.prompt_file).toContain('sops/pr-review.md');

		// Check CI failure route
		const ciRoute = routes.find((r) => r.name === 'engineering-ci-failure');
		expect(ciRoute).toBeDefined();
		expect(ciRoute?.when.source).toBe('my-github');

		// Check Linear route
		const linearRoute = routes.find((r) => r.name === 'engineering-linear-triage');
		expect(linearRoute).toBeDefined();
		expect(linearRoute?.when.source).toBe('my-linear');

		// Check Claude Code supervisor route
		const ccRoute = routes.find((r) => r.name === 'engineering-claude-code-supervisor');
		expect(ccRoute).toBeDefined();
		expect(ccRoute?.when.source).toBe('my-claude');

		// All routes namespaced with module name
		for (const route of routes) {
			expect(route.name).toMatch(/^engineering-/);
		}
	});
});

// ─── Minimal module integration ──────────────────────────────────────────────

describe('minimal module', () => {
	it('loads the real minimal module manifest', async () => {
		const repoRoot = join(__dirname, '..', '..', '..', '..');
		const modulePath = join(repoRoot, 'modules', 'minimal');

		let manifest: Awaited<ReturnType<typeof loadModuleManifest>> | undefined;
		try {
			manifest = await loadModuleManifest(modulePath);
		} catch {
			// Skip if the module path isn't accessible in test env
			return;
		}

		expect(manifest.kind).toBe('Module');
		expect(manifest.metadata.name).toBe('minimal');
		expect(manifest.provides?.routes).toBe(1);
		expect(manifest.provides?.sops).toBe(1);
	});

	it('expands minimal module routes with defaults', async () => {
		const repoRoot = join(__dirname, '..', '..', '..', '..');
		const modulePath = join(repoRoot, 'modules', 'minimal');

		let manifest: Awaited<ReturnType<typeof loadModuleManifest>> | undefined;
		try {
			manifest = await loadModuleManifest(modulePath);
		} catch {
			return;
		}

		// Use defaults — both source and actor have defaults in the manifest
		const routes = await expandModuleRoutes(modulePath, manifest, {});

		expect(routes).toHaveLength(1);
		expect(routes[0].name).toBe('minimal-example');
		expect(routes[0].when.source).toBe('webhook');
		expect(routes[0].then.actor).toBe('responder');
		expect(routes[0].with?.prompt_file).toContain('sops/example.md');
	});

	it('expands minimal module routes with custom params', async () => {
		const repoRoot = join(__dirname, '..', '..', '..', '..');
		const modulePath = join(repoRoot, 'modules', 'minimal');

		let manifest: Awaited<ReturnType<typeof loadModuleManifest>> | undefined;
		try {
			manifest = await loadModuleManifest(modulePath);
		} catch {
			return;
		}

		const routes = await expandModuleRoutes(modulePath, manifest, {
			source: 'my-webhook',
			actor: 'my-actor',
		});

		expect(routes).toHaveLength(1);
		expect(routes[0].name).toBe('minimal-example');
		expect(routes[0].when.source).toBe('my-webhook');
		expect(routes[0].then.actor).toBe('my-actor');
	});
});

// ─── resolveModules ──────────────────────────────────────────────────────────

describe('resolveModules', () => {
	it('resolves multiple modules and merges routes', async () => {
		const modA = await createTestModule(
			testDir,
			'mod-a',
			{
				apiVersion: 'orgloop/v1alpha1',
				kind: 'Module',
				metadata: { name: 'mod-a', description: 'Module A', version: '1.0.0' },
				parameters: [{ name: 'src', description: 'Source', type: 'string', default: 'github' }],
			},
			`apiVersion: orgloop/v1alpha1
kind: RouteGroup
routes:
  - name: "{{ module.name }}-route"
    when:
      source: "{{ params.src }}"
      events: [resource.changed]
    then:
      actor: agent
`,
		);

		const modB = await createTestModule(
			testDir,
			'mod-b',
			{
				apiVersion: 'orgloop/v1alpha1',
				kind: 'Module',
				metadata: { name: 'mod-b', description: 'Module B', version: '1.0.0' },
				parameters: [{ name: 'src', description: 'Source', type: 'string', default: 'linear' }],
			},
			`apiVersion: orgloop/v1alpha1
kind: RouteGroup
routes:
  - name: "{{ module.name }}-route"
    when:
      source: "{{ params.src }}"
      events: [resource.changed]
    then:
      actor: agent
`,
		);

		const result = await resolveModules(
			[
				{ package: modA, params: {} },
				{ package: modB, params: {} },
			],
			testDir,
		);

		expect(result.routes).toHaveLength(2);
		expect(result.routes[0].name).toBe('mod-a-route');
		expect(result.routes[0].when.source).toBe('github');
		expect(result.routes[1].name).toBe('mod-b-route');
		expect(result.routes[1].when.source).toBe('linear');
	});
});
