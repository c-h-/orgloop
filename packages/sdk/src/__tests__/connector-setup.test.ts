/**
 * Tests for ConnectorSetup env_vars — both string and EnvVarDefinition formats.
 * Also tests Stage 2 connector maturity interfaces (CredentialValidator, ServiceDetector).
 */

import type {
	ConnectorRegistration,
	ConnectorSetup,
	CredentialValidator,
	EnvVarDefinition,
	ServiceDetector,
} from '../connector.js';

describe('ConnectorSetup env_vars', () => {
	it('accepts plain string env var names', () => {
		const setup: ConnectorSetup = {
			env_vars: ['GITHUB_TOKEN', 'LINEAR_API_KEY'],
		};
		expect(setup.env_vars).toHaveLength(2);
		expect(setup.env_vars?.[0]).toBe('GITHUB_TOKEN');
	});

	it('accepts rich EnvVarDefinition objects', () => {
		const setup: ConnectorSetup = {
			env_vars: [
				{
					name: 'GITHUB_TOKEN',
					description: 'GitHub personal access token with repo scope',
					help_url: 'https://github.com/settings/tokens/new?scopes=repo',
				},
			],
		};
		const def = setup.env_vars?.[0] as EnvVarDefinition;
		expect(def.name).toBe('GITHUB_TOKEN');
		expect(def.description).toBe('GitHub personal access token with repo scope');
		expect(def.help_url).toBe('https://github.com/settings/tokens/new?scopes=repo');
	});

	it('accepts mixed string and EnvVarDefinition formats', () => {
		const setup: ConnectorSetup = {
			env_vars: [
				'SIMPLE_VAR',
				{
					name: 'RICH_VAR',
					description: 'A rich variable',
					help_command: 'echo "set me up"',
					required: false,
				},
			],
		};
		expect(setup.env_vars).toHaveLength(2);
		expect(typeof setup.env_vars?.[0]).toBe('string');
		expect(typeof setup.env_vars?.[1]).toBe('object');
	});

	it('defaults required to undefined (implicitly true)', () => {
		const def: EnvVarDefinition = {
			name: 'TOKEN',
			description: 'A token',
		};
		expect(def.required).toBeUndefined();
	});

	it('supports optional help_url and help_command', () => {
		const def: EnvVarDefinition = {
			name: 'TOKEN',
			description: 'A token',
		};
		expect(def.help_url).toBeUndefined();
		expect(def.help_command).toBeUndefined();
	});

	it('allows empty env_vars array', () => {
		const setup: ConnectorSetup = {
			env_vars: [],
		};
		expect(setup.env_vars).toHaveLength(0);
	});
});

describe('first-party connector registrations include env_vars', () => {
	it('github connector declares GITHUB_TOKEN', async () => {
		const { default: register } = await import('../../../../connectors/github/src/index.js');
		const reg = register();
		expect(reg.setup?.env_vars).toBeDefined();
		const vars = reg.setup?.env_vars ?? [];
		expect(vars).toHaveLength(1);
		const def = vars[0] as EnvVarDefinition;
		expect(def.name).toBe('GITHUB_TOKEN');
		expect(def.description).toBeTruthy();
		expect(def.help_url).toBeTruthy();
	});

	it('linear connector declares LINEAR_API_KEY', async () => {
		const { default: register } = await import('../../../../connectors/linear/src/index.js');
		const reg = register();
		expect(reg.setup?.env_vars).toBeDefined();
		const vars = reg.setup?.env_vars ?? [];
		expect(vars).toHaveLength(1);
		const def = vars[0] as EnvVarDefinition;
		expect(def.name).toBe('LINEAR_API_KEY');
		expect(def.description).toBeTruthy();
		expect(def.help_url).toBeTruthy();
	});

	it('openclaw connector declares OPENCLAW_WEBHOOK_TOKEN', async () => {
		const { default: register } = await import('../../../../connectors/openclaw/src/index.js');
		const reg = register();
		expect(reg.setup?.env_vars).toBeDefined();
		const vars = reg.setup?.env_vars ?? [];
		expect(vars).toHaveLength(1);
		const def = vars[0] as EnvVarDefinition;
		expect(def.name).toBe('OPENCLAW_WEBHOOK_TOKEN');
		expect(def.description).toBeTruthy();
		expect(def.required).toBe(false);
	});

	it('coding-agent connector declares env_vars (per-harness metadata lives in CLI catalog)', async () => {
		const { default: register } = await import('../../../../connectors/coding-agent/src/index.js');
		const reg = register();
		expect(reg.setup?.env_vars).toBeDefined();
		expect(reg.setup?.env_vars?.length).toBeGreaterThanOrEqual(1);
	});

	it('webhook connector declares WEBHOOK_SECRET as optional', async () => {
		const { default: register } = await import('../../../../connectors/webhook/src/index.js');
		const reg = register();
		expect(reg.setup?.env_vars).toBeDefined();
		const vars = reg.setup?.env_vars ?? [];
		expect(vars).toHaveLength(1);
		const def = vars[0] as EnvVarDefinition;
		expect(def.name).toBe('WEBHOOK_SECRET');
		expect(def.description).toBeTruthy();
		expect(def.required).toBe(false);
	});
});

describe('Stage 2: CredentialValidator interface', () => {
	it('accepts a valid CredentialValidator implementation', () => {
		const validator: CredentialValidator = {
			async validate(_value: string) {
				return {
					valid: true,
					identity: 'user: @test',
					scopes: ['repo', 'read:org'],
				};
			},
		};
		expect(validator).toBeDefined();
		expect(typeof validator.validate).toBe('function');
	});

	it('supports error result', async () => {
		const validator: CredentialValidator = {
			async validate(_value: string) {
				return { valid: false, error: 'Invalid token' };
			},
		};
		const result = await validator.validate('bad-token');
		expect(result.valid).toBe(false);
		expect(result.error).toBe('Invalid token');
	});

	it('supports minimal valid result', async () => {
		const validator: CredentialValidator = {
			async validate(_value: string) {
				return { valid: true };
			},
		};
		const result = await validator.validate('token');
		expect(result.valid).toBe(true);
		expect(result.identity).toBeUndefined();
		expect(result.scopes).toBeUndefined();
	});
});

describe('Stage 2: ServiceDetector interface', () => {
	it('accepts a valid ServiceDetector implementation', () => {
		const detector: ServiceDetector = {
			async detect() {
				return {
					running: true,
					version: '1.0.0',
					endpoint: 'http://localhost:8080',
					details: { uptime: 3600 },
				};
			},
		};
		expect(detector).toBeDefined();
		expect(typeof detector.detect).toBe('function');
	});

	it('supports minimal not-running result', async () => {
		const detector: ServiceDetector = {
			async detect() {
				return { running: false };
			},
		};
		const result = await detector.detect();
		expect(result.running).toBe(false);
		expect(result.version).toBeUndefined();
		expect(result.endpoint).toBeUndefined();
	});
});

describe('Stage 2: ConnectorRegistration with validators and detectors', () => {
	it('github connector exports credential_validators', async () => {
		const { default: register } = await import('../../../../connectors/github/src/index.js');
		const reg = register();
		expect(reg.credential_validators).toBeDefined();
		expect(reg.credential_validators?.GITHUB_TOKEN).toBeDefined();
		expect(typeof reg.credential_validators?.GITHUB_TOKEN.validate).toBe('function');
	});

	it('linear connector exports credential_validators', async () => {
		const { default: register } = await import('../../../../connectors/linear/src/index.js');
		const reg = register();
		expect(reg.credential_validators).toBeDefined();
		expect(reg.credential_validators?.LINEAR_API_KEY).toBeDefined();
		expect(typeof reg.credential_validators?.LINEAR_API_KEY.validate).toBe('function');
	});

	it('openclaw connector exports credential_validators and service_detector', async () => {
		const { default: register } = await import('../../../../connectors/openclaw/src/index.js');
		const reg = register();
		expect(reg.credential_validators).toBeDefined();
		expect(reg.credential_validators?.OPENCLAW_WEBHOOK_TOKEN).toBeDefined();
		expect(reg.service_detector).toBeDefined();
		expect(typeof reg.service_detector?.detect).toBe('function');
	});

	it('ConnectorRegistration allows omitting Stage 2 fields', () => {
		const reg: ConnectorRegistration = {
			id: 'basic',
			setup: { env_vars: ['TOKEN'] },
		};
		expect(reg.credential_validators).toBeUndefined();
		expect(reg.service_detector).toBeUndefined();
	});
});
