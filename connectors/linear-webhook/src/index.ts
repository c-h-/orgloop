/**
 * @orgloop/connector-linear-webhook — Linear webhook source connector registration.
 *
 * Receives Linear webhook POST deliveries and normalizes them into OrgLoop events
 * using the same normalizer functions as the polling Linear connector.
 */

import type { ConnectorRegistration } from '@orgloop/sdk';
import { LinearWebhookSource } from './source.js';

export default function register(): ConnectorRegistration {
	return {
		id: 'linear-webhook',
		source: LinearWebhookSource,
		setup: {
			env_vars: [
				{
					name: 'LINEAR_WEBHOOK_SECRET',
					description: 'HMAC signing secret for validating Linear webhook payloads',
					help_url: 'https://developers.linear.app/docs/graphql/webhooks',
				},
			],
			integrations: [
				{
					id: 'linear-webhook-setup',
					description:
						'Configure a webhook in your Linear workspace settings pointing to the OrgLoop endpoint',
					platform: 'linear',
				},
			],
		},
	};
}

export { LinearWebhookSource } from './source.js';
