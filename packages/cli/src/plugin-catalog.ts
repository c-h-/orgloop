/**
 * PLUGIN_CATALOG — single source of truth for OrgLoop's first-party plugins.
 *
 * Every entry here MUST correspond to a workspace package directory AND a
 * `@orgloop/{connector,transform,logger}-*` devDependency on @orgloop/cli.
 * The `scripts/sync-plugin-catalog.ts` script enforces this invariant.
 *
 * Init derives its scaffold UI from this list. Env/doctor/init read setup
 * metadata (env vars, integrations) from `harnesses[]` entries when the
 * connector is harness-aware (currently `coding-agent`).
 */

import type { ConnectorIntegration, EnvVarDefinition } from '@orgloop/sdk';

export interface HarnessCatalogEntry {
	name: 'claude-code' | 'codex' | 'opencode' | 'pi' | 'pi-rust';
	description: string;
	envVars: EnvVarDefinition[];
	integrations: ConnectorIntegration[];
}

export interface CatalogEntry {
	packageName: string;
	id: string;
	kind: 'source' | 'target' | 'transform' | 'logger';
	description: string;
	scaffoldTemplate?: string;
	harnesses?: HarnessCatalogEntry[];
}

const codingAgentHarnesses: HarnessCatalogEntry[] = [
	{
		name: 'claude-code',
		description: 'Claude Code session lifecycle hook',
		envVars: [
			{
				name: 'CLAUDE_CODE_WEBHOOK_SECRET',
				description: 'HMAC-SHA256 secret for validating webhook signatures (optional)',
				required: false,
			},
		],
		integrations: [
			{
				id: 'claude-code-stop-hook',
				description: 'Install a Stop hook in Claude Code settings so session exits notify OrgLoop',
				platform: 'claude-code',
				command: 'orgloop hook claude-code-stop',
			},
			{
				id: 'claude-code-start-hook',
				description:
					'Install a Start hook in Claude Code settings so session launches notify OrgLoop (optional)',
				platform: 'claude-code',
				command: 'orgloop hook claude-code-start',
			},
		],
	},
	{
		name: 'codex',
		description: 'Codex session lifecycle hook',
		envVars: [
			{
				name: 'CODEX_WEBHOOK_SECRET',
				description: 'HMAC-SHA256 secret for validating webhook signatures (optional)',
				required: false,
			},
		],
		integrations: [
			{
				id: 'codex-stop-hook',
				description: 'Install a Stop hook so Codex session exits notify OrgLoop',
				platform: 'codex',
				command: 'orgloop hook codex-stop',
			},
			{
				id: 'codex-start-hook',
				description: 'Install a Start hook so Codex session launches notify OrgLoop (optional)',
				platform: 'codex',
				command: 'orgloop hook codex-start',
			},
		],
	},
	{
		name: 'opencode',
		description: 'OpenCode session lifecycle hook',
		envVars: [
			{
				name: 'OPENCODE_WEBHOOK_SECRET',
				description: 'HMAC-SHA256 secret for validating webhook signatures (optional)',
				required: false,
			},
		],
		integrations: [
			{
				id: 'opencode-stop-hook',
				description: 'Install a Stop hook so OpenCode session exits notify OrgLoop',
				platform: 'opencode',
				command: 'orgloop hook opencode-stop',
			},
		],
	},
	{
		name: 'pi',
		description: 'Pi session lifecycle hook',
		envVars: [
			{
				name: 'PI_WEBHOOK_SECRET',
				description: 'HMAC-SHA256 secret for validating webhook signatures (optional)',
				required: false,
			},
		],
		integrations: [
			{
				id: 'pi-stop-hook',
				description: 'Install a Stop hook so Pi session exits notify OrgLoop',
				platform: 'pi',
				command: 'orgloop hook pi-stop',
			},
		],
	},
	{
		name: 'pi-rust',
		description: 'Pi-rust session lifecycle hook',
		envVars: [
			{
				name: 'PI_RUST_WEBHOOK_SECRET',
				description: 'HMAC-SHA256 secret for validating webhook signatures (optional)',
				required: false,
			},
		],
		integrations: [
			{
				id: 'pi-rust-stop-hook',
				description: 'Install a Stop hook so pi-rust session exits notify OrgLoop',
				platform: 'pi-rust',
				command: 'orgloop hook pi-rust-stop',
			},
		],
	},
];

export const PLUGIN_CATALOG: CatalogEntry[] = [
	// Connectors
	{
		packageName: '@orgloop/connector-agent-ctl',
		id: 'agent-ctl',
		kind: 'target',
		description: 'Generic agent control delivery target',
	},
	{
		packageName: '@orgloop/connector-coding-agent',
		id: 'coding-agent',
		kind: 'source',
		description: 'Harness-agnostic coding-agent webhook receiver (Claude Code, Codex, …)',
		harnesses: codingAgentHarnesses,
	},
	{
		packageName: '@orgloop/connector-cron',
		id: 'cron',
		kind: 'source',
		description: 'Cron-style scheduled event source',
	},
	{
		packageName: '@orgloop/connector-docker',
		id: 'docker',
		kind: 'source',
		description: 'Docker container event source',
	},
	{
		packageName: '@orgloop/connector-github',
		id: 'github',
		kind: 'source',
		description: 'GitHub repository events (poll-based)',
	},
	{
		packageName: '@orgloop/connector-github-webhook',
		id: 'github-webhook',
		kind: 'source',
		description: 'GitHub webhook receiver (real-time event delivery)',
	},
	{
		packageName: '@orgloop/connector-gog',
		id: 'gog',
		kind: 'source',
		description: 'GoG event source',
	},
	{
		packageName: '@orgloop/connector-linear',
		id: 'linear',
		kind: 'source',
		description: 'Linear project tracking events (poll-based)',
	},
	{
		packageName: '@orgloop/connector-linear-webhook',
		id: 'linear-webhook',
		kind: 'source',
		description: 'Linear webhook receiver',
	},
	{
		packageName: '@orgloop/connector-openclaw',
		id: 'openclaw',
		kind: 'target',
		description: 'OpenClaw engineering agent delivery target',
	},
	{
		packageName: '@orgloop/connector-webhook',
		id: 'webhook',
		kind: 'source',
		description: 'Generic webhook receiver / generic HTTP delivery target',
	},
	// Transforms
	{
		packageName: '@orgloop/transform-agent-gate',
		id: 'agent-gate',
		kind: 'transform',
		description: 'Gate events on agent lifecycle predicates',
	},
	{
		packageName: '@orgloop/transform-dedup',
		id: 'dedup',
		kind: 'transform',
		description: 'Drop duplicate events within a time window',
	},
	{
		packageName: '@orgloop/transform-enrich',
		id: 'enrich',
		kind: 'transform',
		description: 'Add/copy/compute fields on events',
	},
	{
		packageName: '@orgloop/transform-filter',
		id: 'filter',
		kind: 'transform',
		description: 'Match/exclude events by dot-path patterns',
	},
	// Loggers
	{
		packageName: '@orgloop/logger-console',
		id: 'console',
		kind: 'logger',
		description: 'ANSI-coloured stderr logger',
	},
	{
		packageName: '@orgloop/logger-file',
		id: 'file',
		kind: 'logger',
		description: 'Buffered JSONL file logger with rotation',
	},
	{
		packageName: '@orgloop/logger-otel',
		id: 'otel',
		kind: 'logger',
		description: 'OpenTelemetry OTLP export logger',
	},
	{
		packageName: '@orgloop/logger-syslog',
		id: 'syslog',
		kind: 'logger',
		description: 'RFC 5424 syslog logger',
	},
];

export function getCatalogEntry(idOrPackage: string): CatalogEntry | undefined {
	return PLUGIN_CATALOG.find((e) => e.id === idOrPackage || e.packageName === idOrPackage);
}

export function listConnectorIds(): string[] {
	return PLUGIN_CATALOG.filter((e) => e.kind === 'source' || e.kind === 'target').map((e) => e.id);
}

export function listConnectorPackageMap(): Record<string, string> {
	const map: Record<string, string> = {};
	for (const e of PLUGIN_CATALOG) {
		if (e.kind === 'source' || e.kind === 'target') {
			map[e.id] = e.packageName;
		}
	}
	return map;
}
