/**
 * @orgloop/logger-file — registration entry point.
 */

import type { LoggerRegistration } from '@orgloop/sdk';
import { FileLogger } from './file-logger.js';

export function register(): LoggerRegistration {
	return {
		id: 'file',
		logger: FileLogger,
		configSchema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Log file path (default: ~/.orgloop/logs/orgloop.log)',
				},
				format: {
					type: 'string',
					enum: ['jsonl'],
					description: 'Log format (only "jsonl" for MVP).',
					default: 'jsonl',
				},
				rotation: {
					type: 'object',
					properties: {
						max_size: {
							type: 'string',
							description: 'Rotate when file exceeds this size (e.g., "100MB")',
						},
						max_age: {
							type: 'string',
							description: 'Delete rotated files after this duration (e.g., "7d")',
						},
						max_files: { type: 'number', description: 'Keep at most N rotated files', default: 10 },
						compress: { type: 'boolean', description: 'Gzip rotated files', default: true },
					},
				},
				buffer: {
					type: 'object',
					properties: {
						size: { type: 'number', description: 'Buffer N entries before flushing', default: 100 },
						flush_interval: {
							type: 'string',
							description: 'Flush at least every N (e.g., "1s")',
							default: '1s',
						},
					},
				},
			},
			additionalProperties: false,
		},
	};
}

export { FileLogger } from './file-logger.js';
export { needsRotation, parseSize, rotateFile } from './rotation.js';
