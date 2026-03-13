/**
 * @orgloop/connector-linear — Linear source connector registration.
 */

import type { ConnectorRegistration } from '@orgloop/sdk';
import { LinearSource } from './source.js';
import { LinearCredentialValidator } from './validator.js';

export {
	normalizeAssigneeChange,
	normalizeComment,
	normalizeIssueStateChange,
	normalizeLabelChange,
	normalizeNewIssue,
	normalizePriorityChange,
} from './normalizer.js';

export default function register(): ConnectorRegistration {
	return {
		id: 'linear',
		source: LinearSource,
		setup: {
			env_vars: [
				{
					name: 'LINEAR_API_KEY',
					description: 'Linear API key for reading issues and comments',
					help_url: 'https://linear.app/settings/api',
				},
			],
		},
		credential_validators: {
			LINEAR_API_KEY: new LinearCredentialValidator(),
		},
	};
}
