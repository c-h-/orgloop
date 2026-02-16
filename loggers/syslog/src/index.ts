/**
 * @orgloop/logger-syslog — registration entry point.
 */

import type { LoggerRegistration } from '@orgloop/sdk';
import { SyslogLogger } from './syslog-logger.js';

export function register(): LoggerRegistration {
	return {
		id: 'syslog',
		logger: SyslogLogger,
		configSchema: {
			type: 'object',
			properties: {
				transport: {
					type: 'string',
					enum: ['udp', 'tcp', 'unix'],
					description: 'Syslog transport protocol.',
					default: 'udp',
				},
				host: {
					type: 'string',
					description: 'Syslog server host.',
					default: '127.0.0.1',
				},
				port: {
					type: 'number',
					description: 'Syslog server port.',
					default: 514,
				},
				path: {
					type: 'string',
					description: 'Unix socket path (for transport: unix).',
					default: '/dev/log',
				},
				facility: {
					type: 'string',
					enum: [
						'kern',
						'user',
						'mail',
						'daemon',
						'auth',
						'syslog',
						'lpr',
						'news',
						'uucp',
						'cron',
						'authpriv',
						'ftp',
						'local0',
						'local1',
						'local2',
						'local3',
						'local4',
						'local5',
						'local6',
						'local7',
					],
					description: 'Syslog facility name.',
					default: 'local0',
				},
				app_name: {
					type: 'string',
					description: 'APP-NAME field in syslog messages.',
					default: 'orgloop',
				},
				include_structured_data: {
					type: 'boolean',
					description: 'Include [orgloop@49999 ...] structured data element.',
					default: true,
				},
			},
			additionalProperties: false,
		},
	};
}

export type { SyslogLoggerConfig, SyslogTransport } from './syslog-logger.js';
export {
	formatRfc5424,
	getSeverity,
	SyslogLogger,
	TcpTransport,
	UdpTransport,
	UnixTransport,
} from './syslog-logger.js';
