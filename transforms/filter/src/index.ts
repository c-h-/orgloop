/**
 * @orgloop/transform-filter — registration entry point.
 */

import type { TransformRegistration } from '@orgloop/sdk';
import { FilterTransform } from './filter.js';

export function register(): TransformRegistration {
	return {
		id: 'filter',
		transform: FilterTransform,
		configSchema: {
			type: 'object',
			properties: {
				match: {
					type: 'object',
					description: 'Dot-path field → value patterns. All must match for event to pass.',
				},
				match_any: {
					type: 'object',
					description: 'Dot-path field → value patterns. Any match passes the event (OR mode).',
				},
				exclude: {
					type: 'object',
					description: 'Dot-path field → value or array. Any match drops the event.',
				},
				jq: {
					type: 'string',
					description: 'jq expression. Truthy result = pass, falsy/error = drop.',
				},
			},
			additionalProperties: false,
		},
	};
}

export { FilterTransform } from './filter.js';
export { getByPath, matchesAll, matchesAny, matchesValue } from './matcher.js';
