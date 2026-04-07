/**
 * @orgloop/connector-github-webhook — GitHub webhook source connector registration.
 *
 * Receives GitHub webhook POST deliveries and normalizes them into OrgLoop events
 * using the same normalizer functions as the polling GitHub connector.
 */

import type { ConnectorRegistration } from '@orgloop/sdk';
import { GitHubWebhookSource } from './source.js';

export default function register(): ConnectorRegistration {
	return {
		id: 'github-webhook',
		source: GitHubWebhookSource,
		setup: {
			env_vars: [
				{
					name: 'GITHUB_WEBHOOK_SECRET',
					description: 'HMAC-SHA256 secret for validating GitHub webhook signatures',
					help_url:
						'https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries',
				},
				{
					name: 'GITHUB_TOKEN',
					description:
						'GitHub personal access token for enriching events (e.g. workflow_run PR lookup). Optional.',
					help_url: 'https://github.com/settings/tokens/new?scopes=repo',
				},
			],
			integrations: [
				{
					id: 'github-webhook-setup',
					description:
						'Configure a webhook in your GitHub repository settings pointing to the OrgLoop endpoint',
					platform: 'github',
				},
			],
		},
	};
}

export { GitHubWebhookSource } from './source.js';
