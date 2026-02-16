import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanEnvVars } from '../commands/env.js';
import type { EnvWarning } from '../commands/validate.js';

// ─── WQ-38: Validate env var warnings ────────────────────────────────────────

describe('validate env var warnings', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'orgloop-validate-env-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('detects missing env vars from scanned YAML', async () => {
		await mkdir(join(tempDir, 'connectors'), { recursive: true });

		await writeFile(
			join(tempDir, 'orgloop.yaml'),
			`apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: test
connectors:
  - connectors/github.yaml
`,
		);

		await writeFile(
			join(tempDir, 'connectors', 'github.yaml'),
			`sources:
  - id: github
    config:
      token: "\${ORGLOOP_TEST_VALIDATE_TOKEN}"
      repo: "\${ORGLOOP_TEST_VALIDATE_REPO}"
`,
		);

		// Ensure vars are unset
		delete process.env.ORGLOOP_TEST_VALIDATE_TOKEN;
		delete process.env.ORGLOOP_TEST_VALIDATE_REPO;

		const envVars = await scanEnvVars(join(tempDir, 'orgloop.yaml'));
		const envWarnings: EnvWarning[] = [];
		for (const [name, source] of envVars) {
			if (process.env[name] === undefined) {
				envWarnings.push({ name, source });
			}
		}

		expect(envWarnings).toHaveLength(2);
		expect(envWarnings.map((w) => w.name)).toContain('ORGLOOP_TEST_VALIDATE_TOKEN');
		expect(envWarnings.map((w) => w.name)).toContain('ORGLOOP_TEST_VALIDATE_REPO');
	});

	it('does not warn for set env vars', async () => {
		await mkdir(join(tempDir, 'connectors'), { recursive: true });

		await writeFile(
			join(tempDir, 'orgloop.yaml'),
			`apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: test
connectors:
  - connectors/github.yaml
`,
		);

		await writeFile(
			join(tempDir, 'connectors', 'github.yaml'),
			`sources:
  - id: github
    config:
      token: "\${ORGLOOP_TEST_VALIDATE_SET}"
`,
		);

		process.env.ORGLOOP_TEST_VALIDATE_SET = 'present';

		try {
			const envVars = await scanEnvVars(join(tempDir, 'orgloop.yaml'));
			const envWarnings: EnvWarning[] = [];
			for (const [name, source] of envVars) {
				if (process.env[name] === undefined) {
					envWarnings.push({ name, source });
				}
			}

			expect(envWarnings).toHaveLength(0);
		} finally {
			delete process.env.ORGLOOP_TEST_VALIDATE_SET;
		}
	});

	it('reports mixed set and unset vars correctly', async () => {
		await mkdir(join(tempDir, 'connectors'), { recursive: true });

		await writeFile(
			join(tempDir, 'orgloop.yaml'),
			`apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: test
connectors:
  - connectors/mixed.yaml
`,
		);

		await writeFile(
			join(tempDir, 'connectors', 'mixed.yaml'),
			`sources:
  - id: test
    config:
      present: "\${ORGLOOP_TEST_MIX_PRESENT}"
      missing: "\${ORGLOOP_TEST_MIX_MISSING}"
`,
		);

		process.env.ORGLOOP_TEST_MIX_PRESENT = 'yes';
		delete process.env.ORGLOOP_TEST_MIX_MISSING;

		try {
			const envVars = await scanEnvVars(join(tempDir, 'orgloop.yaml'));
			const envWarnings: EnvWarning[] = [];
			for (const [name, source] of envVars) {
				if (process.env[name] === undefined) {
					envWarnings.push({ name, source });
				}
			}

			expect(envWarnings).toHaveLength(1);
			expect(envWarnings[0].name).toBe('ORGLOOP_TEST_MIX_MISSING');
		} finally {
			delete process.env.ORGLOOP_TEST_MIX_PRESENT;
		}
	});
});

// ─── WQ-39: Start pre-flight shows all missing vars ──────────────────────────

describe('start env var pre-flight', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'orgloop-apply-env-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('collects all missing vars instead of failing on first', async () => {
		await mkdir(join(tempDir, 'connectors'), { recursive: true });

		await writeFile(
			join(tempDir, 'orgloop.yaml'),
			`apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: test
connectors:
  - connectors/multi.yaml
`,
		);

		await writeFile(
			join(tempDir, 'connectors', 'multi.yaml'),
			`sources:
  - id: test
    config:
      a: "\${ORGLOOP_TEST_A}"
      b: "\${ORGLOOP_TEST_B}"
      c: "\${ORGLOOP_TEST_C}"
`,
		);

		// Ensure all vars are unset
		delete process.env.ORGLOOP_TEST_A;
		delete process.env.ORGLOOP_TEST_B;
		delete process.env.ORGLOOP_TEST_C;

		const envVars = await scanEnvVars(join(tempDir, 'orgloop.yaml'));
		const missing: string[] = [];

		for (const [name] of envVars) {
			if (process.env[name] === undefined) {
				missing.push(name);
			}
		}

		// All 3 vars should be detected, not just the first
		expect(missing).toHaveLength(3);
		expect(missing).toContain('ORGLOOP_TEST_A');
		expect(missing).toContain('ORGLOOP_TEST_B');
		expect(missing).toContain('ORGLOOP_TEST_C');
	});

	it('passes pre-flight when all vars are set', async () => {
		await mkdir(join(tempDir, 'connectors'), { recursive: true });

		await writeFile(
			join(tempDir, 'orgloop.yaml'),
			`apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: test
connectors:
  - connectors/ok.yaml
`,
		);

		await writeFile(
			join(tempDir, 'connectors', 'ok.yaml'),
			`sources:
  - id: test
    config:
      token: "\${ORGLOOP_TEST_PREFLIGHT_OK}"
`,
		);

		process.env.ORGLOOP_TEST_PREFLIGHT_OK = 'set';

		try {
			const envVars = await scanEnvVars(join(tempDir, 'orgloop.yaml'));
			const missing: string[] = [];

			for (const [name] of envVars) {
				if (process.env[name] === undefined) {
					missing.push(name);
				}
			}

			expect(missing).toHaveLength(0);
		} finally {
			delete process.env.ORGLOOP_TEST_PREFLIGHT_OK;
		}
	});
});
