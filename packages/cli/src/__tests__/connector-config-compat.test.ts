/**
 * Connector config compatibility tests.
 *
 * Ensures the config field names used in YAML generators (init.ts, examples)
 * match what the connector TypeScript source code actually reads.
 *
 * If someone renames a config field in a connector but forgets to update the YAML
 * generators, these tests will catch it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Env setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
	// Mock all env vars the connectors might resolve via ${VAR} syntax
	process.env.GITHUB_TOKEN = 'test-github-token';
	process.env.GITHUB_REPO = 'owner/repo';
	process.env.LINEAR_API_KEY = 'test-linear-api-key';
	process.env.LINEAR_TEAM_KEY = 'TEST';
	process.env.OPENCLAW_WEBHOOK_TOKEN = 'test-openclaw-token';
	process.env.OPENCLAW_AGENT_ID = 'test-agent';
	process.env.OPENCLAW_DEFAULT_TO = 'test-to';
	process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
	process.env.WEBHOOK_SECRET = 'test-secret';
});

afterEach(() => {
	process.env.GITHUB_TOKEN = undefined;
	process.env.GITHUB_REPO = undefined;
	process.env.LINEAR_API_KEY = undefined;
	process.env.LINEAR_TEAM_KEY = undefined;
	process.env.OPENCLAW_WEBHOOK_TOKEN = undefined;
	process.env.OPENCLAW_AGENT_ID = undefined;
	process.env.OPENCLAW_DEFAULT_TO = undefined;
	process.env.SLACK_WEBHOOK_URL = undefined;
	process.env.WEBHOOK_SECRET = undefined;
	vi.restoreAllMocks();
});

// ─── GitHub source ───────────────────────────────────────────────────────────

describe('GitHub connector config compatibility', () => {
	it('init() accepts the config shape from init.ts / YAML templates', async () => {
		const mod = await import('@orgloop/connector-github');
		const reg = mod.default();
		expect(reg.source).toBeDefined();
		const Source = reg.source as NonNullable<typeof reg.source>;
		const source = new Source();

		// This matches the YAML template in init.ts and examples/production/connectors/github.yaml
		await expect(
			source.init({
				id: 'github',
				connector: '@orgloop/connector-github',
				config: {
					repo: '${GITHUB_REPO}',
					token: '${GITHUB_TOKEN}',
					events: [
						'pull_request.review_submitted',
						'pull_request_review_comment',
						'issue_comment',
						'pull_request.closed',
						'pull_request.merged',
						'workflow_run.completed',
					],
				},
			}),
		).resolves.not.toThrow();
	});

	it('register() returns a valid source class', async () => {
		const mod = await import('@orgloop/connector-github');
		const registration = mod.default();
		expect(registration.id).toBe('github');
		expect(registration.source).toBeDefined();
	});

	it('rejects if token field name is wrong (e.g. token_env instead of token)', async () => {
		const mod = await import('@orgloop/connector-github');
		const reg = mod.default();
		expect(reg.source).toBeDefined();
		const Source = reg.source as NonNullable<typeof reg.source>;
		const source = new Source();

		// token_env is the old wrong field name — source reads cfg.token, so
		// resolveEnvVar(undefined) should throw
		await expect(
			source.init({
				id: 'github',
				connector: '@orgloop/connector-github',
				config: {
					repo: 'owner/repo',
					token_env: 'GITHUB_TOKEN', // WRONG field name
					events: ['pull_request.review_submitted'],
				},
			}),
		).rejects.toThrow();
	});
});

// ─── Linear source ───────────────────────────────────────────────────────────

describe('Linear connector config compatibility', () => {
	it('init() accepts the config shape from init.ts / YAML templates', async () => {
		const mod = await import('@orgloop/connector-linear');
		const reg = mod.default();
		expect(reg.source).toBeDefined();
		const Source = reg.source as NonNullable<typeof reg.source>;
		const source = new Source();

		// This matches the YAML template in init.ts and examples/production/connectors/linear.yaml
		await expect(
			source.init({
				id: 'linear',
				connector: '@orgloop/connector-linear',
				config: {
					team: '${LINEAR_TEAM_KEY}',
					api_key: '${LINEAR_API_KEY}',
				},
			}),
		).resolves.not.toThrow();
	});

	it('register() returns a valid source class', async () => {
		const mod = await import('@orgloop/connector-linear');
		const registration = mod.default();
		expect(registration.id).toBe('linear');
		expect(registration.source).toBeDefined();
	});

	it('rejects if api_key field name is wrong (e.g. token_env instead of api_key)', async () => {
		const mod = await import('@orgloop/connector-linear');
		const reg = mod.default();
		expect(reg.source).toBeDefined();
		const Source = reg.source as NonNullable<typeof reg.source>;
		const source = new Source();

		// token_env is the old wrong field name — source reads cfg.api_key
		await expect(
			source.init({
				id: 'linear',
				connector: '@orgloop/connector-linear',
				config: {
					team: 'TEST',
					token_env: 'LINEAR_API_KEY', // WRONG field name
				},
			}),
		).rejects.toThrow();
	});
});

// Claude Code, Codex, OpenCode, Pi, Pi-rust are all served by the
// harness-agnostic @orgloop/connector-coding-agent connector now (P4
// consolidation). The Coding Agent block below covers the
// harness-parametrized init() conformance.

// ─── Coding Agent source ──────────────────────────────────────────────────────

describe('Coding Agent connector config compatibility', () => {
	it('init() accepts empty config (platform defaults to source id)', async () => {
		const mod = await import('@orgloop/connector-coding-agent');
		const reg = mod.default();
		expect(reg.source).toBeDefined();
		const Source = reg.source as NonNullable<typeof reg.source>;
		const source = new Source();

		await expect(
			source.init({
				id: 'my-agent',
				connector: '@orgloop/connector-coding-agent',
				config: {},
			}),
		).resolves.not.toThrow();
	});

	it('init() accepts config with platform and harness', async () => {
		const mod = await import('@orgloop/connector-coding-agent');
		const reg = mod.default();
		expect(reg.source).toBeDefined();
		const Source = reg.source as NonNullable<typeof reg.source>;
		const source = new Source();

		await expect(
			source.init({
				id: 'opencode-src',
				connector: '@orgloop/connector-coding-agent',
				config: {
					platform: 'opencode',
					harness: 'opencode',
				},
			}),
		).resolves.not.toThrow();
	});

	it('init() accepts config with secret', async () => {
		const mod = await import('@orgloop/connector-coding-agent');
		const reg = mod.default();
		expect(reg.source).toBeDefined();
		const Source = reg.source as NonNullable<typeof reg.source>;
		const source = new Source();

		await expect(
			source.init({
				id: 'coding-agent',
				connector: '@orgloop/connector-coding-agent',
				config: {
					platform: 'claude-code',
					secret: '${WEBHOOK_SECRET}',
				},
			}),
		).resolves.not.toThrow();
	});

	it('register() returns a valid source class', async () => {
		const mod = await import('@orgloop/connector-coding-agent');
		const registration = mod.default();
		expect(registration.id).toBe('coding-agent');
		expect(registration.source).toBeDefined();
	});
});

// ─── Coding Agent harness conformance (parametrized) ────────────────────────

describe.each([
	'claude-code',
	'codex',
	'opencode',
	'pi',
	'pi-rust',
] as const)('coding-agent harness=%s', (harness) => {
	it('init() accepts a config block selecting the harness profile', async () => {
		const mod = await import('@orgloop/connector-coding-agent');
		const reg = mod.default();
		expect(reg.source).toBeDefined();
		const Source = reg.source as NonNullable<typeof reg.source>;
		const source = new Source();
		await expect(
			source.init({
				id: harness,
				connector: '@orgloop/connector-coding-agent',
				config: { harness },
			}),
		).resolves.not.toThrow();
	});

	it('init() accepts a config block with secret + harness', async () => {
		const mod = await import('@orgloop/connector-coding-agent');
		const reg = mod.default();
		const Source = reg.source as NonNullable<typeof reg.source>;
		const source = new Source();
		await expect(
			source.init({
				id: harness,
				connector: '@orgloop/connector-coding-agent',
				config: { harness, secret: 'test-secret' },
			}),
		).resolves.not.toThrow();
	});
});

// ─── OpenClaw target ─────────────────────────────────────────────────────────

describe('OpenClaw connector config compatibility', () => {
	it('init() accepts the config shape from init.ts template', async () => {
		const mod = await import('@orgloop/connector-openclaw');
		const reg = mod.default();
		expect(reg.target).toBeDefined();
		const Target = reg.target as NonNullable<typeof reg.target>;
		const target = new Target();

		// This matches the init.ts template for openclaw
		await expect(
			target.init({
				id: 'openclaw-engineering-agent',
				connector: '@orgloop/connector-openclaw',
				config: {
					base_url: 'http://127.0.0.1:18789',
					auth_token_env: '${OPENCLAW_WEBHOOK_TOKEN}',
					agent_id: '${OPENCLAW_AGENT_ID}',
				},
			}),
		).resolves.not.toThrow();
	});

	it('init() accepts the config shape from production YAML (all fields)', async () => {
		const mod = await import('@orgloop/connector-openclaw');
		const reg = mod.default();
		expect(reg.target).toBeDefined();
		const Target = reg.target as NonNullable<typeof reg.target>;
		const target = new Target();

		// This matches examples/production/connectors/openclaw.yaml
		await expect(
			target.init({
				id: 'openclaw-engineering-agent',
				connector: '@orgloop/connector-openclaw',
				config: {
					base_url: 'http://127.0.0.1:18789',
					auth_token_env: '${OPENCLAW_WEBHOOK_TOKEN}',
					agent_id: 'engineering',
					default_channel: 'slack',
					default_to: '${OPENCLAW_DEFAULT_TO}',
				},
			}),
		).resolves.not.toThrow();
	});

	it('init() accepts minimal config (all fields optional)', async () => {
		const mod = await import('@orgloop/connector-openclaw');
		const reg = mod.default();
		expect(reg.target).toBeDefined();
		const Target = reg.target as NonNullable<typeof reg.target>;
		const target = new Target();

		await expect(
			target.init({
				id: 'openclaw-engineering-agent',
				connector: '@orgloop/connector-openclaw',
				config: {},
			}),
		).resolves.not.toThrow();
	});

	it('register() returns a valid target class', async () => {
		const mod = await import('@orgloop/connector-openclaw');
		const registration = mod.default();
		expect(registration.id).toBe('openclaw');
		expect(registration.target).toBeDefined();
	});
});

// ─── Webhook source ──────────────────────────────────────────────────────────

describe('Webhook source connector config compatibility', () => {
	it('init() accepts the config shape from init.ts / minimal example', async () => {
		const mod = await import('@orgloop/connector-webhook');
		const reg = mod.default();
		expect(reg.source).toBeDefined();
		const Source = reg.source as NonNullable<typeof reg.source>;
		const source = new Source();

		// This matches init.ts template and examples/minimal/connectors/webhook.yaml
		await expect(
			source.init({
				id: 'webhook',
				connector: '@orgloop/connector-webhook',
				config: {
					path: '/webhook',
				},
			}),
		).resolves.not.toThrow();
	});

	it('init() accepts config with secret and event_type_field', async () => {
		const mod = await import('@orgloop/connector-webhook');
		const reg = mod.default();
		expect(reg.source).toBeDefined();
		const Source = reg.source as NonNullable<typeof reg.source>;
		const source = new Source();

		await expect(
			source.init({
				id: 'webhook',
				connector: '@orgloop/connector-webhook',
				config: {
					path: '/webhook',
					secret: '${WEBHOOK_SECRET}',
					event_type_field: 'action',
				},
			}),
		).resolves.not.toThrow();
	});

	it('init() accepts empty config', async () => {
		const mod = await import('@orgloop/connector-webhook');
		const reg = mod.default();
		expect(reg.source).toBeDefined();
		const Source = reg.source as NonNullable<typeof reg.source>;
		const source = new Source();

		await expect(
			source.init({
				id: 'webhook',
				connector: '@orgloop/connector-webhook',
				config: {},
			}),
		).resolves.not.toThrow();
	});

	it('register() returns both source and target classes', async () => {
		const mod = await import('@orgloop/connector-webhook');
		const registration = mod.default();
		expect(registration.id).toBe('webhook');
		expect(registration.source).toBeDefined();
		expect(registration.target).toBeDefined();
	});
});

// ─── Webhook target ──────────────────────────────────────────────────────────

describe('Webhook target connector config compatibility', () => {
	it('init() accepts the config shape from init.ts slack template', async () => {
		const mod = await import('@orgloop/connector-webhook');
		const reg = mod.default();
		expect(reg.target).toBeDefined();
		const Target = reg.target as NonNullable<typeof reg.target>;
		const target = new Target();

		// This matches the init.ts "slack" template: just url
		await expect(
			target.init({
				id: 'webhook-target',
				connector: '@orgloop/connector-webhook',
				config: {
					url: '${SLACK_WEBHOOK_URL}',
				},
			}),
		).resolves.not.toThrow();
	});

	it('init() accepts config with method and auth', async () => {
		const mod = await import('@orgloop/connector-webhook');
		const reg = mod.default();
		expect(reg.target).toBeDefined();
		const Target = reg.target as NonNullable<typeof reg.target>;
		const target = new Target();

		// Full config with auth
		await expect(
			target.init({
				id: 'webhook-target',
				connector: '@orgloop/connector-webhook',
				config: {
					url: 'https://example.com/hook',
					method: 'POST',
					headers: { 'X-Custom': 'value' },
					auth: {
						type: 'bearer',
						token: '${WEBHOOK_SECRET}',
					},
				},
			}),
		).resolves.not.toThrow();
	});

	it('init() accepts github-to-slack example config', async () => {
		const mod = await import('@orgloop/connector-webhook');
		const reg = mod.default();
		expect(reg.target).toBeDefined();
		const Target = reg.target as NonNullable<typeof reg.target>;
		const target = new Target();

		// This matches examples/github-to-slack/orgloop.yaml actor config
		await expect(
			target.init({
				id: 'webhook-target',
				connector: '@orgloop/connector-webhook',
				config: {
					url: '${SLACK_WEBHOOK_URL}',
					method: 'POST',
				},
			}),
		).resolves.not.toThrow();
	});
});

// ─── Cron source ──────────────────────────────────────────────────────────────

describe('Cron connector config compatibility', () => {
	it('init() accepts the config shape with cron expressions', async () => {
		const mod = await import('@orgloop/connector-cron');
		const reg = mod.default();
		expect(reg.source).toBeDefined();
		const Source = reg.source as NonNullable<typeof reg.source>;
		const source = new Source();

		await expect(
			source.init({
				id: 'daily-standup',
				connector: '@orgloop/connector-cron',
				config: {
					schedules: [
						{ name: 'standup-reminder', cron: '0 9 * * 1-5' },
						{ name: 'weekly-review', cron: '0 14 * * 5' },
					],
				},
			}),
		).resolves.not.toThrow();
	});

	it('init() accepts the config shape with interval syntax', async () => {
		const mod = await import('@orgloop/connector-cron');
		const reg = mod.default();
		expect(reg.source).toBeDefined();
		const Source = reg.source as NonNullable<typeof reg.source>;
		const source = new Source();

		await expect(
			source.init({
				id: 'heartbeat',
				connector: '@orgloop/connector-cron',
				config: {
					schedules: [{ name: 'heartbeat', cron: 'every 5m' }],
				},
			}),
		).resolves.not.toThrow();
	});

	it('rejects if schedules is empty', async () => {
		const mod = await import('@orgloop/connector-cron');
		const reg = mod.default();
		expect(reg.source).toBeDefined();
		const Source = reg.source as NonNullable<typeof reg.source>;
		const source = new Source();

		await expect(
			source.init({
				id: 'empty-cron',
				connector: '@orgloop/connector-cron',
				config: { schedules: [] },
			}),
		).rejects.toThrow('at least one schedule');
	});

	it('register() returns a valid source class with configSchema', async () => {
		const mod = await import('@orgloop/connector-cron');
		const registration = mod.default();
		expect(registration.id).toBe('cron');
		expect(registration.source).toBeDefined();
		expect(registration.configSchema).toBeDefined();
		expect(registration.setup).toBeDefined();
	});
});
