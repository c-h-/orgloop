/**
 * @orgloop/transform-dedup — registration entry point.
 */

import type { TransformRegistration } from '@orgloop/sdk';
import { DedupTransform } from './dedup.js';

export function register(): TransformRegistration {
	return {
		id: 'dedup',
		transform: DedupTransform,
		configSchema: {
			type: 'object',
			properties: {
				key: {
					type: 'array',
					items: { type: 'string' },
					description: 'Event field paths to use as dedup key.',
				},
				fields: {
					type: 'array',
					items: { type: 'string' },
					description: 'Alias for "key" — event field paths to use as dedup key.',
				},
				window: {
					type: 'string',
					description: 'Duration window for deduplication (e.g., "5m").',
					default: '5m',
				},
				store: {
					type: 'string',
					enum: ['memory'],
					description: 'Storage backend (only "memory" for MVP).',
					default: 'memory',
				},
				track_delivery: {
					type: 'boolean',
					description: 'Track delivery stats (seen vs delivered vs dropped).',
					default: false,
				},
			},
			required: ['window'],
			additionalProperties: false,
		},
	};
}

export type { DedupStats } from './dedup.js';
export { DedupTransform } from './dedup.js';
