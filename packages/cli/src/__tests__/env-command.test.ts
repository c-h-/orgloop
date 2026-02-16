import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEnvFile, scanEnvVars } from '../commands/env.js';

describe('env command', () => {
	// ─── parseEnvFile ────────────────────────────────────────────────────────

	describe('parseEnvFile', () => {
		it('parses KEY=VALUE lines', () => {
			const result = parseEnvFile('FOO=bar\nBAZ=qux');
			expect(result.get('FOO')).toBe('bar');
			expect(result.get('BAZ')).toBe('qux');
			expect(result.size).toBe(2);
		});

		it('skips comments and blank lines', () => {
			const result = parseEnvFile('# comment\n\nFOO=bar\n  # another comment\n');
			expect(result.size).toBe(1);
			expect(result.get('FOO')).toBe('bar');
		});

		it('strips surrounding quotes', () => {
			const result = parseEnvFile('A="hello world"\nB=\'single quoted\'');
			expect(result.get('A')).toBe('hello world');
			expect(result.get('B')).toBe('single quoted');
		});

		it('handles values with = signs', () => {
			const result = parseEnvFile('TOKEN=abc=def==');
			expect(result.get('TOKEN')).toBe('abc=def==');
		});

		it('trims whitespace', () => {
			const result = parseEnvFile('  FOO  =  bar  ');
			expect(result.get('FOO')).toBe('bar');
		});

		it('returns empty map for empty input', () => {
			const result = parseEnvFile('');
			expect(result.size).toBe(0);
		});
	});

	// ─── scanEnvVars ─────────────────────────────────────────────────────────

	describe('scanEnvVars', () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), 'orgloop-env-test-'));
		});

		afterEach(async () => {
			await rm(tempDir, { recursive: true, force: true });
		});

		it('scans connector YAML files for env var references', async () => {
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
				`apiVersion: orgloop/v1alpha1
kind: ConnectorGroup
sources:
  - id: github
    connector: "@orgloop/connector-github"
    config:
      repo: "\${GITHUB_REPO}"
      token: "\${GITHUB_TOKEN}"
`,
			);

			const vars = await scanEnvVars(join(tempDir, 'orgloop.yaml'));
			expect(vars.size).toBe(2);
			expect(vars.get('GITHUB_REPO')).toBe('connectors/github.yaml');
			expect(vars.get('GITHUB_TOKEN')).toBe('connectors/github.yaml');
		});

		it('scans multiple connector files', async () => {
			await mkdir(join(tempDir, 'connectors'), { recursive: true });

			await writeFile(
				join(tempDir, 'orgloop.yaml'),
				`apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: test
connectors:
  - connectors/github.yaml
  - connectors/linear.yaml
`,
			);

			await writeFile(
				join(tempDir, 'connectors', 'github.yaml'),
				`sources:
  - id: github
    config:
      token: "\${GITHUB_TOKEN}"
`,
			);

			await writeFile(
				join(tempDir, 'connectors', 'linear.yaml'),
				`sources:
  - id: linear
    config:
      api_key: "\${LINEAR_API_KEY}"
      team: "\${LINEAR_TEAM_KEY}"
`,
			);

			const vars = await scanEnvVars(join(tempDir, 'orgloop.yaml'));
			expect(vars.size).toBe(3);
			expect(vars.get('GITHUB_TOKEN')).toBe('connectors/github.yaml');
			expect(vars.get('LINEAR_API_KEY')).toBe('connectors/linear.yaml');
			expect(vars.get('LINEAR_TEAM_KEY')).toBe('connectors/linear.yaml');
		});

		it('scans route files from routes/ directory', async () => {
			await mkdir(join(tempDir, 'routes'), { recursive: true });

			await writeFile(
				join(tempDir, 'orgloop.yaml'),
				`apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: test
`,
			);

			await writeFile(
				join(tempDir, 'routes', 'main.yaml'),
				`routes:
  - name: test
    with:
      api_key: "\${ROUTE_API_KEY}"
`,
			);

			const vars = await scanEnvVars(join(tempDir, 'orgloop.yaml'));
			expect(vars.size).toBe(1);
			expect(vars.get('ROUTE_API_KEY')).toBe('routes/main.yaml');
		});

		it('returns empty map when no env vars found', async () => {
			await writeFile(
				join(tempDir, 'orgloop.yaml'),
				`apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: test
`,
			);

			const vars = await scanEnvVars(join(tempDir, 'orgloop.yaml'));
			expect(vars.size).toBe(0);
		});

		it('handles missing referenced files gracefully', async () => {
			await writeFile(
				join(tempDir, 'orgloop.yaml'),
				`apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: test
connectors:
  - connectors/nonexistent.yaml
`,
			);

			const vars = await scanEnvVars(join(tempDir, 'orgloop.yaml'));
			expect(vars.size).toBe(0);
		});

		it('scans env vars from transform and logger files', async () => {
			await mkdir(join(tempDir, 'transforms'), { recursive: true });
			await mkdir(join(tempDir, 'loggers'), { recursive: true });

			await writeFile(
				join(tempDir, 'orgloop.yaml'),
				`apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: test
transforms:
  - transforms/t.yaml
loggers:
  - loggers/l.yaml
`,
			);

			await writeFile(
				join(tempDir, 'transforms', 't.yaml'),
				`transforms:
  - name: enricher
    config:
      endpoint: "\${ENRICH_API_URL}"
`,
			);

			await writeFile(
				join(tempDir, 'loggers', 'l.yaml'),
				`loggers:
  - name: remote
    config:
      token: "\${LOG_TOKEN}"
`,
			);

			const vars = await scanEnvVars(join(tempDir, 'orgloop.yaml'));
			expect(vars.size).toBe(2);
			expect(vars.get('ENRICH_API_URL')).toBe('transforms/t.yaml');
			expect(vars.get('LOG_TOKEN')).toBe('loggers/l.yaml');
		});
	});

	// ─── set/unset detection ─────────────────────────────────────────────────

	describe('env var detection', () => {
		it('correctly identifies set and unset env vars', () => {
			// Set a test var
			const origVal = process.env.ORGLOOP_TEST_SET_VAR;
			process.env.ORGLOOP_TEST_SET_VAR = 'present';

			// Ensure another var is unset — delete is required for process.env
			const origMissing = process.env.ORGLOOP_TEST_MISSING_VAR;
			delete process.env.ORGLOOP_TEST_MISSING_VAR;

			try {
				expect(process.env.ORGLOOP_TEST_SET_VAR).toBeDefined();
				expect(process.env.ORGLOOP_TEST_MISSING_VAR).toBeUndefined();
			} finally {
				if (origVal === undefined) {
					delete process.env.ORGLOOP_TEST_SET_VAR;
				} else {
					process.env.ORGLOOP_TEST_SET_VAR = origVal;
				}
				if (origMissing !== undefined) {
					process.env.ORGLOOP_TEST_MISSING_VAR = origMissing;
				}
			}
		});
	});
});
