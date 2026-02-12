/**
 * OpenTelemetry logger — exports OrgLoop LogEntry data via OTLP.
 *
 * Maps LogEntry fields to OTel LogRecord attributes and uses
 * phase-based severity mapping for structured observability.
 */

import type { LoggerProvider } from '@opentelemetry/sdk-logs';
import type { LogEntry, LogPhase, Logger } from '@orgloop/sdk';

/** Phase → OTel severity number mapping (follows OTel severity spec) */
const PHASE_SEVERITY: Record<LogPhase, { text: string; number: number }> = {
	'source.emit': { text: 'INFO', number: 9 },
	'transform.start': { text: 'INFO', number: 9 },
	'transform.pass': { text: 'INFO', number: 9 },
	'transform.drop': { text: 'INFO', number: 9 },
	'transform.error': { text: 'WARN', number: 13 },
	'transform.error_drop': { text: 'WARN', number: 13 },
	'transform.error_halt': { text: 'ERROR', number: 17 },
	'route.match': { text: 'INFO', number: 9 },
	'route.no_match': { text: 'DEBUG', number: 5 },
	'deliver.attempt': { text: 'INFO', number: 9 },
	'deliver.success': { text: 'INFO', number: 9 },
	'deliver.failure': { text: 'ERROR', number: 17 },
	'deliver.retry': { text: 'WARN', number: 13 },
	'system.start': { text: 'INFO', number: 9 },
	'system.stop': { text: 'INFO', number: 9 },
	'system.error': { text: 'ERROR', number: 17 },
	'source.circuit_open': { text: 'WARN', number: 13 },
	'source.circuit_retry': { text: 'INFO', number: 9 },
	'source.circuit_close': { text: 'INFO', number: 9 },
	'module.loading': { text: 'INFO', number: 9 },
	'module.active': { text: 'INFO', number: 9 },
	'module.unloading': { text: 'INFO', number: 9 },
	'module.removed': { text: 'INFO', number: 9 },
	'module.error': { text: 'ERROR', number: 17 },
	'runtime.start': { text: 'INFO', number: 9 },
	'runtime.stop': { text: 'INFO', number: 9 },
};

export interface OtelLoggerConfig {
	endpoint?: string;
	protocol?: 'http/json' | 'http/protobuf' | 'grpc';
	headers?: Record<string, string>;
	service_name?: string;
	service_version?: string;
	resource_attributes?: Record<string, string>;
	batch?: {
		max_queue_size?: number;
		scheduled_delay_ms?: number;
		max_export_batch_size?: number;
	};
}

export class OtelLogger implements Logger {
	readonly id = 'otel';
	private loggerProvider: LoggerProvider | null = null;
	private otelLogger: ReturnType<LoggerProvider['getLogger']> | null = null;

	async init(config: Record<string, unknown>): Promise<void> {
		const cfg = config as OtelLoggerConfig;

		const { Resource } = await import('@opentelemetry/resources');
		const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import(
			'@opentelemetry/semantic-conventions'
		);
		const { LoggerProvider, BatchLogRecordProcessor } = await import('@opentelemetry/sdk-logs');
		const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-http');

		const resourceAttrs: Record<string, string> = {
			[ATTR_SERVICE_NAME]: cfg.service_name ?? 'orgloop',
			...(cfg.service_version ? { [ATTR_SERVICE_VERSION]: cfg.service_version } : {}),
			...(cfg.resource_attributes ?? {}),
		};

		const resource = new Resource(resourceAttrs);

		const exporter = new OTLPLogExporter({
			url: cfg.endpoint ?? 'http://localhost:4318/v1/logs',
			headers: cfg.headers,
		});

		const batchConfig = cfg.batch ?? {};
		const processor = new BatchLogRecordProcessor(exporter, {
			maxQueueSize: batchConfig.max_queue_size ?? 2048,
			scheduledDelayMillis: batchConfig.scheduled_delay_ms ?? 5000,
			maxExportBatchSize: batchConfig.max_export_batch_size ?? 512,
		});

		this.loggerProvider = new LoggerProvider({ resource });
		this.loggerProvider.addLogRecordProcessor(processor);
		this.otelLogger = this.loggerProvider.getLogger('orgloop', '0.1.0');
	}

	async log(entry: LogEntry): Promise<void> {
		try {
			if (!this.otelLogger) return;

			const severity = PHASE_SEVERITY[entry.phase] ?? { text: 'INFO', number: 9 };

			const attributes: Record<string, string | number> = {
				'orgloop.phase': entry.phase,
				'orgloop.event_id': entry.event_id,
				'orgloop.trace_id': entry.trace_id,
			};

			if (entry.source) attributes['orgloop.source'] = entry.source;
			if (entry.target) attributes['orgloop.target'] = entry.target;
			if (entry.route) attributes['orgloop.route'] = entry.route;
			if (entry.transform) attributes['orgloop.transform'] = entry.transform;
			if (entry.event_type) attributes['orgloop.event_type'] = entry.event_type;
			if (entry.duration_ms !== undefined) attributes['orgloop.duration_ms'] = entry.duration_ms;
			if (entry.error) attributes['orgloop.error'] = entry.error;
			if (entry.result) attributes['orgloop.result'] = entry.result;
			if (entry.queue_depth !== undefined) attributes['orgloop.queue_depth'] = entry.queue_depth;
			if (entry.hostname) attributes['orgloop.hostname'] = entry.hostname;
			if (entry.workspace) attributes['orgloop.workspace'] = entry.workspace;
			if (entry.orgloop_version) attributes['orgloop.version'] = entry.orgloop_version;

			this.otelLogger.emit({
				severityNumber: severity.number,
				severityText: severity.text,
				body: JSON.stringify(entry),
				timestamp: new Date(entry.timestamp),
				attributes,
			});
		} catch {
			// Loggers must not throw
		}
	}

	async flush(): Promise<void> {
		try {
			await this.loggerProvider?.forceFlush();
		} catch {
			// Loggers must not throw
		}
	}

	async shutdown(): Promise<void> {
		try {
			await this.loggerProvider?.shutdown();
		} catch {
			// Loggers must not throw
		}
		this.loggerProvider = null;
		this.otelLogger = null;
	}
}

export { PHASE_SEVERITY };
