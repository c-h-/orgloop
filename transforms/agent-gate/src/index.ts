/**
 * @orgloop/transform-agent-gate — registration entry point.
 */

import type { TransformRegistration } from '@orgloop/sdk';
import { AgentGateTransform } from './agent-gate.js';

export function register(): TransformRegistration {
	return {
		id: 'agent-gate',
		transform: AgentGateTransform,
		configSchema: {
			type: 'object',
			properties: {
				binary_path: {
					type: 'string',
					description: 'Path to agent-ctl binary.',
					default: 'agent-ctl',
				},
				adapter_filter: {
					type: 'string',
					description: 'Only count sessions from this adapter (e.g. "claude-code").',
				},
				active_statuses: {
					type: 'array',
					items: { type: 'string' },
					description: 'Statuses considered "running" (default: ["running"]).',
					default: ['running'],
				},
				timeout: {
					type: 'number',
					description: 'Timeout for CLI call in ms.',
					default: 5000,
				},
			},
			additionalProperties: false,
		},
	};
}

export type { AgentGateConfig } from './agent-gate.js';
export { AgentGateTransform } from './agent-gate.js';
