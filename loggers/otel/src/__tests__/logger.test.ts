/**
 * Tests for the OpenTelemetry logger.
 *
 * Mocks the OTLP exporter to verify LogEntry → LogRecord mapping,
 * severity mapping, resource attributes, and lifecycle behavior.
 */

import type { LogEntry, LogPhase } from '@orgloop/sdk';
import { OtelLogger, PHASE_SEVERITY } from '../otel-logger.js';

// ─── Mock OTel modules ───────────────────────────────────────────────────────

interface EmittedRecord {
	severityNumber: number;
	severityText: string;
	body: string;
	timestamp: Date;
	attributes: Record<string, string | number>;
}

const emittedRecords: EmittedRecord[] = [];
let mockExporterShutdownCalled = false;
let mockProviderForceFlushCalled = false;
let mockProviderShutdownCalled = false;
let mockExporterConfig: Record<string, unknown> = {};
let mockBatchConfig: Record<string, unknown> = {};
let mockResourceAttrs: Record<string, string> = {};

// Track whether exporter should fail
let exporterShouldFail = false;

function resetMocks() {
	emittedRecords.length = 0;
	mockExporterShutdownCalled = false;
	mockProviderForceFlushCalled = false;
	mockProviderShutdownCalled = false;
	mockExporterConfig = {};
	mockBatchConfig = {};
	mockResourceAttrs = {};
	exporterShouldFail = false;
}

// Mock OTel modules
vi.mock('@opentelemetry/resources', () => ({
	resourceFromAttributes(attrs: Record<string, string>) {
		mockResourceAttrs = attrs;
		return attrs;
	},
}));

vi.mock('@opentelemetry/semantic-conventions', () => ({
	ATTR_SERVICE_NAME: 'service.name',
	ATTR_SERVICE_VERSION: 'service.version',
}));

vi.mock('@opentelemetry/exporter-logs-otlp-http', () => ({
	OTLPLogExporter: class MockOTLPLogExporter {
		constructor(config: Record<string, unknown>) {
			mockExporterConfig = config;
		}
		export(_records: unknown[], cb: (result: { code: number }) => void) {
			if (exporterShouldFail) {
				cb({ code: 1 });
			} else {
				cb({ code: 0 });
			}
		}
		shutdown() {
			mockExporterShutdownCalled = true;
			return Promise.resolve();
		}
	},
}));

vi.mock('@opentelemetry/sdk-logs', () => {
	return {
		LoggerProvider: class MockLoggerProvider {
			getLogger(_name: string, _version: string) {
				return {
					emit(record: EmittedRecord) {
						emittedRecords.push({ ...record });
					},
				};
			}
			async forceFlush() {
				mockProviderForceFlushCalled = true;
			}
			async shutdown() {
				mockProviderShutdownCalled = true;
			}
		},
		BatchLogRecordProcessor: class MockBatchProcessor {
			constructor(_exporter: unknown, config: Record<string, unknown>) {
				mockBatchConfig = config;
			}
		},
	};
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createEntry(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		timestamp: '2025-01-15T10:30:00.000Z',
		event_id: 'evt_test123',
		trace_id: 'trc_abc456',
		phase: 'deliver.success',
		source: 'github-prs',
		target: 'openclaw-agent',
		route: 'pr-review',
		event_type: 'resource.changed',
		duration_ms: 150,
		...overrides,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OtelLogger', () => {
	let logger: OtelLogger;

	beforeEach(() => {
		resetMocks();
		logger = new OtelLogger();
	});

	afterEach(async () => {
		await logger.shutdown();
	});

	describe('init', () => {
		it('initializes with default config', async () => {
			await logger.init({});

			expect(mockExporterConfig).toEqual({
				url: 'http://localhost:4318/v1/logs',
				headers: undefined,
			});
			expect(mockResourceAttrs['service.name']).toBe('orgloop');
			expect(mockBatchConfig).toEqual({
				maxQueueSize: 2048,
				scheduledDelayMillis: 5000,
				maxExportBatchSize: 512,
			});
		});

		it('initializes with custom endpoint and headers', async () => {
			await logger.init({
				endpoint: 'https://otel.example.com/v1/logs',
				headers: { Authorization: 'Bearer tok123' },
			});

			expect(mockExporterConfig).toEqual({
				url: 'https://otel.example.com/v1/logs',
				headers: { Authorization: 'Bearer tok123' },
			});
		});

		it('sets custom service name and version', async () => {
			await logger.init({
				service_name: 'my-orgloop',
				service_version: '1.2.3',
			});

			expect(mockResourceAttrs['service.name']).toBe('my-orgloop');
			expect(mockResourceAttrs['service.version']).toBe('1.2.3');
		});

		it('sets custom resource attributes', async () => {
			await logger.init({
				resource_attributes: {
					environment: 'production',
					region: 'us-east-1',
				},
			});

			expect(mockResourceAttrs.environment).toBe('production');
			expect(mockResourceAttrs.region).toBe('us-east-1');
		});

		it('applies custom batch configuration', async () => {
			await logger.init({
				batch: {
					max_queue_size: 4096,
					scheduled_delay_ms: 10000,
					max_export_batch_size: 1024,
				},
			});

			expect(mockBatchConfig).toEqual({
				maxQueueSize: 4096,
				scheduledDelayMillis: 10000,
				maxExportBatchSize: 1024,
			});
		});
	});

	describe('log — LogEntry to LogRecord mapping', () => {
		beforeEach(async () => {
			await logger.init({});
		});

		it('maps all LogEntry fields to OTel attributes', async () => {
			const entry = createEntry({
				transform: 'dedup',
				result: 'delivered',
				queue_depth: 5,
				hostname: 'worker-01',
				workspace: 'my-org',
				orgloop_version: '0.1.0',
				error: undefined,
			});

			await logger.log(entry);

			expect(emittedRecords).toHaveLength(1);
			const record = emittedRecords[0];

			expect(record.attributes['orgloop.phase']).toBe('deliver.success');
			expect(record.attributes['orgloop.event_id']).toBe('evt_test123');
			expect(record.attributes['orgloop.trace_id']).toBe('trc_abc456');
			expect(record.attributes['orgloop.source']).toBe('github-prs');
			expect(record.attributes['orgloop.target']).toBe('openclaw-agent');
			expect(record.attributes['orgloop.route']).toBe('pr-review');
			expect(record.attributes['orgloop.event_type']).toBe('resource.changed');
			expect(record.attributes['orgloop.duration_ms']).toBe(150);
			expect(record.attributes['orgloop.transform']).toBe('dedup');
			expect(record.attributes['orgloop.result']).toBe('delivered');
			expect(record.attributes['orgloop.queue_depth']).toBe(5);
			expect(record.attributes['orgloop.hostname']).toBe('worker-01');
			expect(record.attributes['orgloop.workspace']).toBe('my-org');
			expect(record.attributes['orgloop.version']).toBe('0.1.0');
		});

		it('omits undefined optional fields from attributes', async () => {
			const entry: LogEntry = {
				timestamp: '2025-01-15T10:30:00.000Z',
				event_id: 'evt_min',
				trace_id: 'trc_min',
				phase: 'system.start',
			};

			await logger.log(entry);

			expect(emittedRecords).toHaveLength(1);
			const attrs = emittedRecords[0].attributes;

			expect(attrs['orgloop.phase']).toBe('system.start');
			expect(attrs['orgloop.event_id']).toBe('evt_min');
			expect(attrs['orgloop.trace_id']).toBe('trc_min');
			expect('orgloop.source' in attrs).toBe(false);
			expect('orgloop.target' in attrs).toBe(false);
			expect('orgloop.route' in attrs).toBe(false);
			expect('orgloop.error' in attrs).toBe(false);
			expect('orgloop.duration_ms' in attrs).toBe(false);
		});

		it('sets body to JSON-serialized LogEntry', async () => {
			const entry = createEntry();
			await logger.log(entry);

			expect(emittedRecords).toHaveLength(1);
			const parsed = JSON.parse(emittedRecords[0].body);
			expect(parsed.event_id).toBe('evt_test123');
			expect(parsed.phase).toBe('deliver.success');
		});

		it('sets timestamp from LogEntry', async () => {
			const entry = createEntry({ timestamp: '2025-06-01T12:00:00.000Z' });
			await logger.log(entry);

			expect(emittedRecords).toHaveLength(1);
			expect(emittedRecords[0].timestamp).toEqual(new Date('2025-06-01T12:00:00.000Z'));
		});

		it('includes error attribute when present', async () => {
			const entry = createEntry({
				phase: 'deliver.failure',
				error: 'Connection refused',
			});

			await logger.log(entry);

			expect(emittedRecords).toHaveLength(1);
			expect(emittedRecords[0].attributes['orgloop.error']).toBe('Connection refused');
		});
	});

	describe('severity mapping', () => {
		beforeEach(async () => {
			await logger.init({});
		});

		const errorPhases: LogPhase[] = ['deliver.failure', 'system.error'];
		for (const phase of errorPhases) {
			it(`maps ${phase} to ERROR severity`, async () => {
				await logger.log(createEntry({ phase }));
				expect(emittedRecords[0].severityText).toBe('ERROR');
				expect(emittedRecords[0].severityNumber).toBe(17);
			});
		}

		const warnPhases: LogPhase[] = ['transform.error', 'deliver.retry'];
		for (const phase of warnPhases) {
			it(`maps ${phase} to WARN severity`, async () => {
				await logger.log(createEntry({ phase }));
				expect(emittedRecords[0].severityText).toBe('WARN');
				expect(emittedRecords[0].severityNumber).toBe(13);
			});
		}

		const infoPhases: LogPhase[] = [
			'source.emit',
			'transform.start',
			'transform.pass',
			'transform.drop',
			'route.match',
			'deliver.attempt',
			'deliver.success',
			'system.start',
			'system.stop',
		];
		for (const phase of infoPhases) {
			it(`maps ${phase} to INFO severity`, async () => {
				await logger.log(createEntry({ phase }));
				expect(emittedRecords[0].severityText).toBe('INFO');
				expect(emittedRecords[0].severityNumber).toBe(9);
			});
		}

		it('maps route.no_match to DEBUG severity', async () => {
			await logger.log(createEntry({ phase: 'route.no_match' }));
			expect(emittedRecords[0].severityText).toBe('DEBUG');
			expect(emittedRecords[0].severityNumber).toBe(5);
		});

		it('covers all LogPhase values in PHASE_SEVERITY', () => {
			const allPhases: LogPhase[] = [
				'source.emit',
				'transform.start',
				'transform.pass',
				'transform.drop',
				'transform.error',
				'route.match',
				'route.no_match',
				'deliver.attempt',
				'deliver.success',
				'deliver.failure',
				'deliver.retry',
				'system.start',
				'system.stop',
				'system.error',
			];
			for (const phase of allPhases) {
				expect(PHASE_SEVERITY[phase]).toBeDefined();
				expect(PHASE_SEVERITY[phase].text).toBeDefined();
				expect(PHASE_SEVERITY[phase].number).toBeGreaterThan(0);
			}
		});
	});

	describe('flush', () => {
		it('calls forceFlush on the provider', async () => {
			await logger.init({});
			await logger.flush();
			expect(mockProviderForceFlushCalled).toBe(true);
		});

		it('does not throw when not initialized', async () => {
			await expect(logger.flush()).resolves.toBeUndefined();
		});
	});

	describe('shutdown', () => {
		it('calls shutdown on the provider', async () => {
			await logger.init({});
			await logger.shutdown();
			expect(mockProviderShutdownCalled).toBe(true);
		});

		it('nullifies provider and logger after shutdown', async () => {
			await logger.init({});
			await logger.shutdown();

			// Logging after shutdown should be a no-op (no throws)
			await expect(logger.log(createEntry())).resolves.toBeUndefined();
			expect(emittedRecords).toHaveLength(0);
		});

		it('does not throw when not initialized', async () => {
			await expect(logger.shutdown()).resolves.toBeUndefined();
		});

		it('does not throw on double shutdown', async () => {
			await logger.init({});
			await logger.shutdown();
			await expect(logger.shutdown()).resolves.toBeUndefined();
		});
	});

	describe('error resilience', () => {
		it('does not throw when log is called before init', async () => {
			await expect(logger.log(createEntry())).resolves.toBeUndefined();
			expect(emittedRecords).toHaveLength(0);
		});

		it('handles multiple rapid log calls', async () => {
			await logger.init({});

			const entries = Array.from({ length: 100 }, (_, i) => createEntry({ event_id: `evt_${i}` }));

			await Promise.all(entries.map((e) => logger.log(e)));

			expect(emittedRecords).toHaveLength(100);
		});
	});

	describe('registration', () => {
		it('exports a valid register() function', async () => {
			const { register } = await import('../index.js');
			const reg = register();

			expect(reg.id).toBe('otel');
			expect(reg.logger).toBe(OtelLogger);
			expect(reg.configSchema).toBeDefined();
			expect((reg.configSchema as Record<string, unknown>).type).toBe('object');
		});

		it('config schema includes all expected properties', async () => {
			const { register } = await import('../index.js');
			const reg = register();
			const schema = reg.configSchema as { properties: Record<string, unknown> };

			expect(schema.properties).toHaveProperty('endpoint');
			expect(schema.properties).toHaveProperty('protocol');
			expect(schema.properties).toHaveProperty('headers');
			expect(schema.properties).toHaveProperty('service_name');
			expect(schema.properties).toHaveProperty('service_version');
			expect(schema.properties).toHaveProperty('resource_attributes');
			expect(schema.properties).toHaveProperty('batch');
		});
	});
});
