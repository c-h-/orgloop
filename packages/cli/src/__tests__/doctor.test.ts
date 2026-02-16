import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CredentialValidator, ServiceDetector } from '@orgloop/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCredentials, checkServices, checkValidation, runDoctor } from '../commands/doctor.js';

describe('doctor command', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'orgloop-doctor-test-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	// ─── Helpers ──────────────────────────────────────────────────────────

	async function writeMinimalProject(name = 'test-project'): Promise<string> {
		const configPath = join(tempDir, 'orgloop.yaml');
		await writeFile(
			configPath,
			`apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: ${name}
`,
		);
		return configPath;
	}

	async function writeFullProject(): Promise<string> {
		const configPath = join(tempDir, 'orgloop.yaml');
		await mkdir(join(tempDir, 'connectors'), { recursive: true });
		await mkdir(join(tempDir, 'routes'), { recursive: true });

		await writeFile(
			configPath,
			`apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: full-project
connectors:
  - connectors/github.yaml
  - connectors/openclaw.yaml
`,
		);

		await writeFile(
			join(tempDir, 'connectors', 'github.yaml'),
			`sources:
  - id: github
    connector: "@orgloop/connector-github"
    config:
      repo: "\${GITHUB_REPO}"
      token: "\${GITHUB_TOKEN}"
`,
		);

		await writeFile(
			join(tempDir, 'connectors', 'openclaw.yaml'),
			`actors:
  - id: agent
    connector: "@orgloop/connector-openclaw"
    config:
      agent_id: "\${OPENCLAW_AGENT_ID}"
`,
		);

		await writeFile(
			join(tempDir, 'routes', 'main.yaml'),
			`routes:
  - name: github-to-agent
    when:
      source: github
      events: [resource.changed]
    then:
      actor: agent
`,
		);

		return configPath;
	}

	// ─── checkValidation (delegates to validate) ─────────────────────────

	describe('checkValidation', () => {
		it('returns ok for valid config', async () => {
			const configPath = await writeMinimalProject();
			const checks = await checkValidation(configPath);

			const yamlCheck = checks.find((c) => c.name === configPath);
			expect(yamlCheck).toBeDefined();
			expect(yamlCheck?.status).toBe('ok');
		});

		it('returns error for invalid YAML syntax', async () => {
			const configPath = join(tempDir, 'orgloop.yaml');
			await writeFile(configPath, '{ invalid yaml: [');

			const checks = await checkValidation(configPath);
			const errorCheck = checks.find((c) => c.status === 'error');
			expect(errorCheck).toBeDefined();
		});

		it('returns error for missing required fields', async () => {
			const configPath = join(tempDir, 'orgloop.yaml');
			await writeFile(configPath, 'kind: NotAProject\n');

			const checks = await checkValidation(configPath);
			const errorCheck = checks.find((c) => c.status === 'error');
			expect(errorCheck).toBeDefined();
		});

		it('detects dead sources as route-graph warnings', async () => {
			await mkdir(join(tempDir, 'connectors'), { recursive: true });
			await mkdir(join(tempDir, 'routes'), { recursive: true });

			const configPath = join(tempDir, 'orgloop.yaml');
			await writeFile(
				configPath,
				`apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: test
connectors:
  - connectors/sources.yaml
  - connectors/actors.yaml
`,
			);

			await writeFile(
				join(tempDir, 'connectors', 'sources.yaml'),
				`sources:
  - id: github
    connector: "@orgloop/connector-github"
    config: {}
  - id: linear
    connector: "@orgloop/connector-linear"
    config: {}
`,
			);

			await writeFile(
				join(tempDir, 'connectors', 'actors.yaml'),
				`actors:
  - id: agent
    connector: "@orgloop/connector-openclaw"
    config: {}
`,
			);

			await writeFile(
				join(tempDir, 'routes', 'main.yaml'),
				`routes:
  - name: r1
    when:
      source: github
      events: [resource.changed]
    then:
      actor: agent
`,
			);

			const checks = await checkValidation(configPath);
			const deadSource = checks.find(
				(c) => c.category === 'route-graph' && c.name === 'linear' && c.status === 'warning',
			);
			expect(deadSource).toBeDefined();
			expect(deadSource?.detail).toContain('not referenced');
		});

		it('returns error for missing config file', async () => {
			const checks = await checkValidation(join(tempDir, 'nonexistent.yaml'));
			const errorCheck = checks.find((c) => c.status === 'error');
			expect(errorCheck).toBeDefined();
		});
	});

	// ─── checkCredentials ─────────────────────────────────────────────────

	describe('checkCredentials', () => {
		it('returns ok for set env vars', async () => {
			const configPath = await writeFullProject();

			const origRepo = process.env.GITHUB_REPO;
			const origToken = process.env.GITHUB_TOKEN;
			const origAgent = process.env.OPENCLAW_AGENT_ID;
			process.env.GITHUB_REPO = 'test/repo';
			process.env.GITHUB_TOKEN = 'ghp_test';
			process.env.OPENCLAW_AGENT_ID = 'agent-1';

			try {
				const checks = await checkCredentials(configPath);
				const okChecks = checks.filter((c) => c.status === 'ok');
				expect(okChecks.length).toBe(3);
			} finally {
				if (origRepo === undefined) {
					delete process.env.GITHUB_REPO;
				} else {
					process.env.GITHUB_REPO = origRepo;
				}
				if (origToken === undefined) {
					delete process.env.GITHUB_TOKEN;
				} else {
					process.env.GITHUB_TOKEN = origToken;
				}
				if (origAgent === undefined) {
					delete process.env.OPENCLAW_AGENT_ID;
				} else {
					process.env.OPENCLAW_AGENT_ID = origAgent;
				}
			}
		});

		it('returns missing with metadata for unset env vars', async () => {
			const configPath = await writeFullProject();

			// Ensure the vars are unset
			const origRepo = process.env.GITHUB_REPO;
			const origToken = process.env.GITHUB_TOKEN;
			const origAgent = process.env.OPENCLAW_AGENT_ID;
			delete process.env.GITHUB_REPO;
			delete process.env.GITHUB_TOKEN;
			delete process.env.OPENCLAW_AGENT_ID;

			try {
				const checks = await checkCredentials(configPath);
				const missingChecks = checks.filter((c) => c.status === 'missing');
				expect(missingChecks.length).toBe(3);

				const tokenCheck = missingChecks.find((c) => c.name === 'GITHUB_TOKEN');
				expect(tokenCheck).toBeDefined();
				expect(tokenCheck?.description).toBe('GitHub personal access token with repo scope');
				expect(tokenCheck?.help_url).toContain('github.com');
			} finally {
				if (origRepo !== undefined) process.env.GITHUB_REPO = origRepo;
				if (origToken !== undefined) process.env.GITHUB_TOKEN = origToken;
				if (origAgent !== undefined) process.env.OPENCLAW_AGENT_ID = origAgent;
			}
		});

		it('returns empty for project with no env vars', async () => {
			const configPath = await writeMinimalProject();
			const checks = await checkCredentials(configPath);
			expect(checks).toHaveLength(0);
		});
	});

	// ─── runDoctor (integration) ──────────────────────────────────────────

	// Mock import function that prevents real connector resolution in tests.
	// This ensures runDoctor tests don't make real API calls through validators.
	const noopImportFn = async () => {
		throw new Error('mock: no connectors available');
	};

	describe('runDoctor', () => {
		it('returns ok status when all checks pass', async () => {
			const configPath = await writeFullProject();

			// Set all env vars
			const origRepo = process.env.GITHUB_REPO;
			const origToken = process.env.GITHUB_TOKEN;
			const origAgent = process.env.OPENCLAW_AGENT_ID;
			process.env.GITHUB_REPO = 'test/repo';
			process.env.GITHUB_TOKEN = 'ghp_test';
			process.env.OPENCLAW_AGENT_ID = 'agent-1';

			try {
				const result = await runDoctor(configPath, noopImportFn);
				expect(result.status).toBe('ok');
				expect(result.project).toBe('full-project');
				expect(result.checks.every((c) => c.status === 'ok')).toBe(true);
			} finally {
				if (origRepo === undefined) {
					delete process.env.GITHUB_REPO;
				} else {
					process.env.GITHUB_REPO = origRepo;
				}
				if (origToken === undefined) {
					delete process.env.GITHUB_TOKEN;
				} else {
					process.env.GITHUB_TOKEN = origToken;
				}
				if (origAgent === undefined) {
					delete process.env.OPENCLAW_AGENT_ID;
				} else {
					process.env.OPENCLAW_AGENT_ID = origAgent;
				}
			}
		});

		it('returns degraded when credentials are missing', async () => {
			const configPath = await writeFullProject();

			// Ensure vars are unset
			const origRepo = process.env.GITHUB_REPO;
			const origToken = process.env.GITHUB_TOKEN;
			const origAgent = process.env.OPENCLAW_AGENT_ID;
			delete process.env.GITHUB_REPO;
			delete process.env.GITHUB_TOKEN;
			delete process.env.OPENCLAW_AGENT_ID;

			try {
				const result = await runDoctor(configPath, noopImportFn);
				expect(result.status).toBe('degraded');
				expect(result.checks.some((c) => c.status === 'missing')).toBe(true);
			} finally {
				if (origRepo !== undefined) process.env.GITHUB_REPO = origRepo;
				if (origToken !== undefined) process.env.GITHUB_TOKEN = origToken;
				if (origAgent !== undefined) process.env.OPENCLAW_AGENT_ID = origAgent;
			}
		});

		it('returns error when config is invalid', async () => {
			const configPath = join(tempDir, 'orgloop.yaml');
			await writeFile(configPath, '{ broken yaml: [');

			const result = await runDoctor(configPath, noopImportFn);
			expect(result.status).toBe('error');
			expect(result.checks.some((c) => c.status === 'error')).toBe(true);
		});

		it('produces correct JSON structure', async () => {
			const configPath = await writeMinimalProject('json-test');
			const result = await runDoctor(configPath, noopImportFn);

			expect(result).toHaveProperty('status');
			expect(result).toHaveProperty('project', 'json-test');
			expect(result).toHaveProperty('checks');
			expect(Array.isArray(result.checks)).toBe(true);

			for (const check of result.checks) {
				expect(check).toHaveProperty('category');
				expect(check).toHaveProperty('name');
				expect(check).toHaveProperty('status');
				expect(['ok', 'missing', 'error', 'warning']).toContain(check.status);
				expect(['credential', 'config', 'transform', 'route-graph', 'service']).toContain(
					check.category,
				);
			}
		});
	});

	// ─── checkCredentials with validators (Stage 2) ──────────────────────

	describe('checkCredentials with credential validators', () => {
		it('calls validator when env var is set and validator exists', async () => {
			const configPath = await writeFullProject();

			const origToken = process.env.GITHUB_TOKEN;
			const origRepo = process.env.GITHUB_REPO;
			const origAgent = process.env.OPENCLAW_AGENT_ID;
			process.env.GITHUB_TOKEN = 'ghp_test';
			process.env.GITHUB_REPO = 'test/repo';
			process.env.OPENCLAW_AGENT_ID = 'agent-1';

			const mockValidator: CredentialValidator = {
				validate: async (_value: string) => ({
					valid: true,
					identity: 'user: @alice',
					scopes: ['repo', 'read:org'],
				}),
			};

			const validators = new Map<string, CredentialValidator>();
			validators.set('GITHUB_TOKEN', mockValidator);

			try {
				const checks = await checkCredentials(configPath, validators);
				const tokenCheck = checks.find((c) => c.name === 'GITHUB_TOKEN');
				expect(tokenCheck).toBeDefined();
				expect(tokenCheck?.status).toBe('ok');
				expect(tokenCheck?.detail).toContain('valid');
				expect(tokenCheck?.detail).toContain('user: @alice');
				expect(tokenCheck?.detail).toContain('scopes: repo, read:org');
				expect(tokenCheck?.identity).toBe('user: @alice');
				expect(tokenCheck?.scopes).toEqual(['repo', 'read:org']);
			} finally {
				if (origToken === undefined) {
					delete process.env.GITHUB_TOKEN;
				} else {
					process.env.GITHUB_TOKEN = origToken;
				}
				if (origRepo === undefined) {
					delete process.env.GITHUB_REPO;
				} else {
					process.env.GITHUB_REPO = origRepo;
				}
				if (origAgent === undefined) {
					delete process.env.OPENCLAW_AGENT_ID;
				} else {
					process.env.OPENCLAW_AGENT_ID = origAgent;
				}
			}
		});

		it('reports error when validator says credential is invalid', async () => {
			const configPath = await writeFullProject();

			const origToken = process.env.GITHUB_TOKEN;
			const origRepo = process.env.GITHUB_REPO;
			const origAgent = process.env.OPENCLAW_AGENT_ID;
			process.env.GITHUB_TOKEN = 'bad-token';
			process.env.GITHUB_REPO = 'test/repo';
			process.env.OPENCLAW_AGENT_ID = 'agent-1';

			const mockValidator: CredentialValidator = {
				validate: async (_value: string) => ({
					valid: false,
					error: 'Invalid token (401 Unauthorized)',
				}),
			};

			const validators = new Map<string, CredentialValidator>();
			validators.set('GITHUB_TOKEN', mockValidator);

			try {
				const checks = await checkCredentials(configPath, validators);
				const tokenCheck = checks.find((c) => c.name === 'GITHUB_TOKEN');
				expect(tokenCheck).toBeDefined();
				expect(tokenCheck?.status).toBe('error');
				expect(tokenCheck?.detail).toContain('Invalid token');
			} finally {
				if (origToken === undefined) {
					delete process.env.GITHUB_TOKEN;
				} else {
					process.env.GITHUB_TOKEN = origToken;
				}
				if (origRepo === undefined) {
					delete process.env.GITHUB_REPO;
				} else {
					process.env.GITHUB_REPO = origRepo;
				}
				if (origAgent === undefined) {
					delete process.env.OPENCLAW_AGENT_ID;
				} else {
					process.env.OPENCLAW_AGENT_ID = origAgent;
				}
			}
		});

		it('falls back to presence check when no validator exists', async () => {
			const configPath = await writeFullProject();

			const origRepo = process.env.GITHUB_REPO;
			const origToken = process.env.GITHUB_TOKEN;
			const origAgent = process.env.OPENCLAW_AGENT_ID;
			process.env.GITHUB_REPO = 'test/repo';
			process.env.GITHUB_TOKEN = 'ghp_test';
			process.env.OPENCLAW_AGENT_ID = 'agent-1';

			// Empty validators map — no validators registered
			const validators = new Map<string, CredentialValidator>();

			try {
				const checks = await checkCredentials(configPath, validators);
				const okChecks = checks.filter((c) => c.status === 'ok');
				expect(okChecks.length).toBe(3);
				// No detail should be set for presence-only checks
				for (const check of okChecks) {
					expect(check.identity).toBeUndefined();
					expect(check.scopes).toBeUndefined();
				}
			} finally {
				if (origRepo === undefined) {
					delete process.env.GITHUB_REPO;
				} else {
					process.env.GITHUB_REPO = origRepo;
				}
				if (origToken === undefined) {
					delete process.env.GITHUB_TOKEN;
				} else {
					process.env.GITHUB_TOKEN = origToken;
				}
				if (origAgent === undefined) {
					delete process.env.OPENCLAW_AGENT_ID;
				} else {
					process.env.OPENCLAW_AGENT_ID = origAgent;
				}
			}
		});

		it('falls back to ok when validator throws', async () => {
			const configPath = await writeFullProject();

			const origToken = process.env.GITHUB_TOKEN;
			const origRepo = process.env.GITHUB_REPO;
			const origAgent = process.env.OPENCLAW_AGENT_ID;
			process.env.GITHUB_TOKEN = 'ghp_test';
			process.env.GITHUB_REPO = 'test/repo';
			process.env.OPENCLAW_AGENT_ID = 'agent-1';

			const throwingValidator: CredentialValidator = {
				validate: async () => {
					throw new Error('Validator crashed');
				},
			};

			const validators = new Map<string, CredentialValidator>();
			validators.set('GITHUB_TOKEN', throwingValidator);

			try {
				const checks = await checkCredentials(configPath, validators);
				const tokenCheck = checks.find((c) => c.name === 'GITHUB_TOKEN');
				expect(tokenCheck).toBeDefined();
				expect(tokenCheck?.status).toBe('ok');
			} finally {
				if (origToken === undefined) {
					delete process.env.GITHUB_TOKEN;
				} else {
					process.env.GITHUB_TOKEN = origToken;
				}
				if (origRepo === undefined) {
					delete process.env.GITHUB_REPO;
				} else {
					process.env.GITHUB_REPO = origRepo;
				}
				if (origAgent === undefined) {
					delete process.env.OPENCLAW_AGENT_ID;
				} else {
					process.env.OPENCLAW_AGENT_ID = origAgent;
				}
			}
		});
	});

	// ─── checkServices (Stage 2) ─────────────────────────────────────────

	describe('checkServices', () => {
		it('returns ok for running service', async () => {
			const mockDetector: ServiceDetector = {
				detect: async () => ({
					running: true,
					endpoint: 'http://localhost:18789',
				}),
			};

			const detectors = new Map<string, ServiceDetector>();
			detectors.set('openclaw', mockDetector);

			const checks = await checkServices(detectors);
			expect(checks).toHaveLength(1);
			expect(checks[0].status).toBe('ok');
			expect(checks[0].name).toBe('openclaw');
			expect(checks[0].detail).toContain('running');
			expect(checks[0].detail).toContain('http://localhost:18789');
		});

		it('returns warning for non-running service', async () => {
			const mockDetector: ServiceDetector = {
				detect: async () => ({
					running: false,
					endpoint: 'http://localhost:18789',
				}),
			};

			const detectors = new Map<string, ServiceDetector>();
			detectors.set('openclaw', mockDetector);

			const checks = await checkServices(detectors);
			expect(checks).toHaveLength(1);
			expect(checks[0].status).toBe('warning');
			expect(checks[0].detail).toContain('not reachable');
		});

		it('returns warning when detector throws', async () => {
			const throwingDetector: ServiceDetector = {
				detect: async () => {
					throw new Error('Detection failed');
				},
			};

			const detectors = new Map<string, ServiceDetector>();
			detectors.set('some-service', throwingDetector);

			const checks = await checkServices(detectors);
			expect(checks).toHaveLength(1);
			expect(checks[0].status).toBe('warning');
			expect(checks[0].detail).toContain('detection failed');
		});

		it('returns empty for no detectors', async () => {
			const detectors = new Map<string, ServiceDetector>();
			const checks = await checkServices(detectors);
			expect(checks).toHaveLength(0);
		});
	});
});
