/**
 * @orgloop/connector-coding-agent — Harness-agnostic webhook receiver.
 *
 * Selects the runtime profile via the `harness` config field. Per-harness
 * onboarding metadata (env-var names, integrations) lives in the CLI's
 * PLUGIN_CATALOG; this register() returns a generic placeholder so callers
 * that query the SDK seam directly still get something useful.
 */

import type { ConnectorRegistration } from '@orgloop/sdk';
import { HARNESS_PROFILES } from './harness-profiles/index.js';
import { CodingAgentSource } from './source.js';

export type { HarnessName, HarnessProfile } from './harness-profiles/index.js';
export { getHarnessProfile, HARNESS_PROFILES } from './harness-profiles/index.js';
export type { CodingAgentSourceConfig } from './source.js';
export { CodingAgentSource } from './source.js';

export default function register(): ConnectorRegistration {
	return {
		id: 'coding-agent',
		source: CodingAgentSource,
		configSchema: {
			type: 'object',
			properties: {
				harness: { type: 'string', enum: Object.keys(HARNESS_PROFILES) },
				secret: { type: 'string' },
				buffer_dir: { type: 'string' },
				max_buffer_size: { type: 'string' },
				platform: { type: 'string' },
			},
		},
		setup: {
			env_vars: [
				{
					name: 'WEBHOOK_SECRET',
					description:
						'HMAC-SHA256 secret for validating webhook signatures (per-harness env var name lives in the CLI plugin catalog)',
					required: false,
				},
			],
		},
	};
}
