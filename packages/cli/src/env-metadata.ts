/**
 * Shared environment variable metadata for DX surfaces.
 *
 * Combines a curated registry of common credentials with harness-specific
 * env vars sourced from PLUGIN_CATALOG so the env/doctor commands surface
 * descriptions consistently.
 */

import { PLUGIN_CATALOG } from './plugin-catalog.js';

export interface EnvVarMeta {
	description: string;
	help_url?: string;
}

const STATIC_ENV_VAR_METADATA: Record<string, EnvVarMeta> = {
	GITHUB_TOKEN: {
		description: 'GitHub personal access token with repo scope',
		help_url: 'https://github.com/settings/tokens/new?scopes=repo',
	},
	GITHUB_REPO: {
		description: 'GitHub repository in owner/repo format',
	},
	LINEAR_API_KEY: {
		description: 'Linear API key for reading issues and comments',
		help_url: 'https://linear.app/settings/api',
	},
	LINEAR_TEAM_KEY: {
		description: 'Linear team key',
	},
	OPENCLAW_WEBHOOK_TOKEN: {
		description: 'OpenClaw webhook authentication token',
		help_url: 'https://openclaw.com/docs/webhooks',
	},
	OPENCLAW_AGENT_ID: {
		description: 'OpenClaw agent ID',
	},
	SLACK_WEBHOOK_URL: {
		description: 'Slack incoming webhook URL',
	},
	PAGERDUTY_WEBHOOK_URL: {
		description: 'PagerDuty webhook URL',
	},
};

function buildCatalogEnvIndex(): Record<string, EnvVarMeta> {
	const out: Record<string, EnvVarMeta> = {};
	for (const entry of PLUGIN_CATALOG) {
		for (const harness of entry.harnesses ?? []) {
			for (const v of harness.envVars) {
				out[v.name] = {
					description: v.description,
					...(v.help_url ? { help_url: v.help_url } : {}),
				};
			}
		}
	}
	return out;
}

const CATALOG_ENV_VAR_METADATA = buildCatalogEnvIndex();

export function getEnvVarMeta(name: string): EnvVarMeta | undefined {
	return STATIC_ENV_VAR_METADATA[name] ?? CATALOG_ENV_VAR_METADATA[name];
}
