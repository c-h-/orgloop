/**
 * Shared environment variable metadata for DX surfaces.
 *
 * Provides per-variable descriptions and help URLs so that CLI commands
 * (env, start, validate) can show actionable guidance for missing vars.
 */

export interface EnvVarMeta {
	description: string;
	help_url?: string;
}

const ENV_VAR_METADATA: Record<string, EnvVarMeta> = {
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

export function getEnvVarMeta(name: string): EnvVarMeta | undefined {
	return ENV_VAR_METADATA[name];
}
