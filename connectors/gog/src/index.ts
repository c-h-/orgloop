/**
 * @orgloop/connector-gog — GOG (Gmail) source connector registration.
 */

import type { ConnectorRegistration } from '@orgloop/sdk';
import { GogSource } from './source.js';

export default function register(): ConnectorRegistration {
	return {
		id: 'gog',
		source: GogSource,
		setup: {
			integrations: [
				{
					id: 'gog-cli',
					description: 'GOG CLI must be installed and authenticated (gog auth login)',
					platform: 'gog',
					command: 'gog auth login',
				},
			],
		},
	};
}
