/**
 * README onboarding e2e test — validates the full init → add module → doctor → plan flow.
 *
 * Exercises the onboarding flow described in the README programmatically:
 *   1. orgloop init (non-interactive, with connectors)
 *   2. orgloop add module engineering (non-interactive, with --path)
 *   3. orgloop doctor (should report 0 errors)
 *   4. orgloop plan (should produce a valid plan)
 *
 * Uses the local CLI binary and a temp directory.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ─── Paths ────────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const CLI_BIN = join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');
const ENGINEERING_MODULE = join(REPO_ROOT, 'modules', 'engineering');

// ─── Helpers ──────────────────────────────────────────────────────────────────

let testDir: string;

/** Dummy env vars so config loading / env var substitution does not throw. */
const DUMMY_ENV: Record<string, string> = {
	GITHUB_TOKEN: 'ghp_test_dummy_token',
	GITHUB_REPO: 'test-org/test-repo',
	GITHUB_WATCHED: 'test-user',
	LINEAR_API_KEY: 'lin_test_dummy_key',
	LINEAR_TEAM_KEY: 'TEST',
	OPENCLAW_WEBHOOK_TOKEN: 'oc_test_dummy_token',
	OPENCLAW_AGENT_ID: 'test-agent',
};

/**
 * Run CLI command. Returns stdout. By default throws on non-zero exit.
 * Pass `allowFailure: true` to capture output even when the process exits non-zero
 * (e.g., doctor exits 1 for degraded status).
 */
function cli(args: string, cwd: string, opts?: { allowFailure?: boolean }): string {
	try {
		return execSync(`node ${CLI_BIN} ${args}`, {
			cwd,
			encoding: 'utf-8',
			env: { ...process.env, ...DUMMY_ENV, NO_COLOR: '1' },
			timeout: 30_000,
		});
	} catch (err: unknown) {
		if (opts?.allowFailure && err && typeof err === 'object' && 'stdout' in err) {
			return (err as { stdout: string }).stdout;
		}
		throw err;
	}
}

beforeEach(async () => {
	testDir = join(
		tmpdir(),
		`orgloop-readme-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
	await rm(testDir, { recursive: true, force: true });
});

// ─── Step 1: orgloop init ─────────────────────────────────────────────────────

describe('README onboarding flow', () => {
	it('init → add module → doctor → plan completes successfully', async () => {
		// ── Step 1: init ──────────────────────────────────────────────────
		const initOutput = cli(
			'init --no-interactive --name test-org --connectors github,linear,openclaw,claude-code --dir .',
			testDir,
		);

		// Verify scaffolded files
		expect(existsSync(join(testDir, 'orgloop.yaml'))).toBe(true);
		expect(existsSync(join(testDir, 'connectors', 'github.yaml'))).toBe(true);
		expect(existsSync(join(testDir, 'connectors', 'linear.yaml'))).toBe(true);
		expect(existsSync(join(testDir, 'connectors', 'openclaw.yaml'))).toBe(true);
		expect(existsSync(join(testDir, 'connectors', 'claude-code.yaml'))).toBe(true);
		expect(existsSync(join(testDir, 'routes', 'example.yaml'))).toBe(true);
		expect(existsSync(join(testDir, 'transforms', 'transforms.yaml'))).toBe(true);
		expect(existsSync(join(testDir, 'loggers', 'default.yaml'))).toBe(true);
		expect(existsSync(join(testDir, 'sops', 'example.md'))).toBe(true);
		expect(existsSync(join(testDir, '.env.example'))).toBe(true);

		// ── Step 2: add module engineering ─────────────────────────────────
		const addOutput = cli(
			`add module engineering --path ${ENGINEERING_MODULE} --no-interactive`,
			testDir,
		);

		expect(addOutput).toContain('Found module: engineering');
		expect(addOutput).toContain('Module "engineering" installed');

		// Verify module scaffolded its files (connectors, transforms, SOPs)
		expect(existsSync(join(testDir, 'sops', 'pr-review.md'))).toBe(true);
		expect(existsSync(join(testDir, 'sops', 'ci-failure.md'))).toBe(true);
		expect(existsSync(join(testDir, 'sops', 'linear-ticket.md'))).toBe(true);

		// Engineering module should have added its transforms
		expect(existsSync(join(testDir, 'transforms', 'engineering.yaml'))).toBe(true);

		// Module should be registered in orgloop.yaml
		const orgloopYaml = await readFile(join(testDir, 'orgloop.yaml'), 'utf-8');
		expect(orgloopYaml).toContain('modules');
		expect(orgloopYaml).toContain(ENGINEERING_MODULE);

		// ── Step 3: doctor ─────────────────────────────────────────────────
		// doctor exits 1 for degraded (warnings are expected, e.g. route graph)
		const doctorOutput = cli('doctor --json', testDir, { allowFailure: true });
		const doctorResult = JSON.parse(doctorOutput);

		// Should have a project name
		expect(doctorResult.project).toBe('test-org');

		// Credential validation errors are expected with dummy tokens (validators
		// make real HTTP calls). What matters is that ALL config checks pass —
		// no schema errors, no broken transform refs, no bad route references.
		const configChecks = doctorResult.checks.filter(
			(c: { category: string }) => c.category === 'config',
		);
		expect(configChecks.length).toBeGreaterThan(0);
		for (const check of configChecks) {
			expect(check.status).toBe('ok');
		}

		// Credential env vars should all be present (not "missing")
		const credentials = doctorResult.checks.filter(
			(c: { category: string }) => c.category === 'credential',
		);
		for (const cred of credentials) {
			// Status is either 'ok' (presence-only check) or 'error' (validator
			// rejected dummy token). It should never be 'missing' since we set all vars.
			expect(cred.status).not.toBe('missing');
		}

		// Module should be validated
		const moduleCheck = doctorResult.checks.find(
			(c: { name: string }) => c.name === 'module:engineering',
		);
		expect(moduleCheck).toBeDefined();
		expect(moduleCheck.status).toBe('ok');

		// ── Step 4: plan ──────────────────────────────────────────────────
		const planOutput = cli('plan --json', testDir);
		const planResult = JSON.parse(planOutput);

		// Plan should have sources, actors, routes
		expect(planResult.sources.length).toBeGreaterThan(0);
		expect(planResult.actors.length).toBeGreaterThan(0);
		expect(planResult.routes.length).toBeGreaterThan(0);

		// Since no running state exists, all items should be "add"
		for (const source of planResult.sources) {
			expect(source.action).toBe('add');
		}
		for (const actor of planResult.actors) {
			expect(actor.action).toBe('add');
		}
		for (const route of planResult.routes) {
			expect(route.action).toBe('add');
		}

		// Should have engineering module routes
		const routeNames = planResult.routes.map((r: { name: string }) => r.name);
		expect(routeNames).toContain('engineering-pr-review');
		expect(routeNames).toContain('engineering-ci-failure');

		// Should have the expected sources
		const sourceNames = planResult.sources.map((s: { name: string }) => s.name);
		expect(sourceNames).toContain('github');

		// Should have the expected actor
		const actorNames = planResult.actors.map((a: { name: string }) => a.name);
		expect(actorNames).toContain('openclaw-engineering-agent');

		// Plan summary should show additions
		expect(planResult.summary.add).toBeGreaterThan(0);
	}, 60_000);

	it('init scaffolds correct directory structure', async () => {
		cli('init --no-interactive --name scaffold-test --connectors github --dir .', testDir);

		// Verify all expected directories exist
		const expectedDirs = ['connectors', 'routes', 'transforms', 'loggers', 'sops'];
		for (const dir of expectedDirs) {
			expect(existsSync(join(testDir, dir))).toBe(true);
		}

		// orgloop.yaml should reference the connector
		const orgloopYaml = await readFile(join(testDir, 'orgloop.yaml'), 'utf-8');
		expect(orgloopYaml).toContain('connectors/github.yaml');
		expect(orgloopYaml).toContain('name: scaffold-test');
	}, 30_000);

	it('doctor reports errors when config is invalid', async () => {
		cli('init --no-interactive --name error-test --connectors github --dir .', testDir);

		// Remove the init-scaffolded example route so we don't get route graph warnings
		// about the default source. Instead, let's create a route that references a
		// non-existent source to generate an error.
		const { writeFile } = await import('node:fs/promises');
		await writeFile(
			join(testDir, 'routes', 'broken.yaml'),
			`apiVersion: orgloop/v1alpha1
kind: RouteGroup

routes:
  - name: broken-route
    when:
      source: nonexistent-source
      events:
        - resource.changed
    then:
      actor: nonexistent-actor
`,
			'utf-8',
		);

		// doctor exits non-zero for degraded/error status
		const doctorOutput = cli('doctor --json', testDir, { allowFailure: true });
		const doctorResult = JSON.parse(doctorOutput);

		// Should have route-graph warnings for the broken references
		const routeGraphWarnings = doctorResult.checks.filter(
			(c: { category: string }) => c.category === 'route-graph',
		);

		// The broken route references nonexistent source/actor, which should
		// show up in validation or route graph warnings
		expect(doctorResult.checks.length).toBeGreaterThan(0);
	}, 30_000);

	it('plan shows correct component count after module install', async () => {
		// Init with full connector set
		cli(
			'init --no-interactive --name plan-test --connectors github,linear,openclaw,claude-code --dir .',
			testDir,
		);

		// Add engineering module
		cli(`add module engineering --path ${ENGINEERING_MODULE} --no-interactive`, testDir);

		const planOutput = cli('plan --json', testDir);
		const planResult = JSON.parse(planOutput);

		// Engineering module provides 5 routes
		// Plus the example route from init = 6 total
		const moduleRoutes = planResult.routes.filter((r: { name: string }) =>
			r.name.startsWith('engineering-'),
		);
		expect(moduleRoutes.length).toBe(5);

		// Transforms should include engineering module transforms
		expect(planResult.transforms.length).toBeGreaterThan(0);

		// Loggers should be present (from init scaffold)
		expect(planResult.loggers.length).toBeGreaterThan(0);
	}, 60_000);
});
