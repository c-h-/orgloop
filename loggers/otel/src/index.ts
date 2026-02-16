/**
 * @orgloop/logger-otel — registration entry point.
 */

import type { LoggerRegistration } from '@orgloop/sdk';
import { OtelLogger } from './otel-logger.js';

export function register(): LoggerRegistration {
	return {
		id: 'otel',
		logger: OtelLogger,
		configSchema: {
			type: 'object',
			properties: {
				endpoint: {
					type: 'string',
					description: 'OTLP HTTP endpoint for log export.',
					default: 'http://localhost:4318/v1/logs',
				},
				protocol: {
					type: 'string',
					enum: ['http/json', 'http/protobuf', 'grpc'],
					description: 'OTLP transport protocol.',
					default: 'http/json',
				},
				headers: {
					type: 'object',
					description: 'Custom headers for OTLP requests (e.g., authorization).',
					additionalProperties: { type: 'string' },
				},
				service_name: {
					type: 'string',
					description: 'OTel service name resource attribute.',
					default: 'orgloop',
				},
				service_version: {
					type: 'string',
					description: 'OTel service version resource attribute.',
				},
				resource_attributes: {
					type: 'object',
					description: 'Additional OTel resource attributes.',
					additionalProperties: { type: 'string' },
				},
				batch: {
					type: 'object',
					description: 'Batch processor configuration.',
					properties: {
						max_queue_size: {
							type: 'number',
							description: 'Maximum queue size before dropping.',
							default: 2048,
						},
						scheduled_delay_ms: {
							type: 'number',
							description: 'Delay between batch exports in milliseconds.',
							default: 5000,
						},
						max_export_batch_size: {
							type: 'number',
							description: 'Maximum number of records per export batch.',
							default: 512,
						},
					},
					additionalProperties: false,
				},
			},
			additionalProperties: false,
		},
	};
}

export { OtelLogger, PHASE_SEVERITY } from './otel-logger.js';
