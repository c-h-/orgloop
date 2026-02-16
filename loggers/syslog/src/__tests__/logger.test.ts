/**
 * Tests for @orgloop/logger-syslog
 *
 * Tests RFC 5424 formatting, severity mapping, transport behavior,
 * and error resilience using injected mock transports.
 */

import type { LogEntry, LogPhase } from '@orgloop/sdk';
import { register } from '../index.js';
import type { SyslogTransport } from '../syslog-logger.js';
import { formatRfc5424, getSeverity, SyslogLogger } from '../syslog-logger.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		timestamp: '2025-01-15T10:30:00.000Z',
		event_id: 'evt_abc123',
		trace_id: 'trc_xyz789',
		phase: 'deliver.success',
		source: 'github',
		event_type: 'resource.changed',
		duration_ms: 89,
		...overrides,
	};
}

/** Mock transport that captures sent messages */
class MockTransport implements SyslogTransport {
	messages: string[] = [];
	closed = false;
	sendError = false;

	send(message: string): void {
		if (this.sendError) throw new Error('send failed');
		this.messages.push(message);
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

// ─── Registration ────────────────────────────────────────────────────────────

describe('register()', () => {
	it('returns a valid LoggerRegistration', () => {
		const reg = register();
		expect(reg.id).toBe('syslog');
		expect(reg.logger).toBe(SyslogLogger);
		expect(reg.configSchema).toBeDefined();
		expect(reg.configSchema?.type).toBe('object');
	});
});

// ─── Severity Mapping ────────────────────────────────────────────────────────

describe('getSeverity()', () => {
	it('maps deliver.failure to Error (3)', () => {
		expect(getSeverity('deliver.failure')).toBe(3);
	});

	it('maps system.error to Error (3)', () => {
		expect(getSeverity('system.error')).toBe(3);
	});

	it('maps system.error with fatal to Critical (2)', () => {
		expect(getSeverity('system.error', { fatal: true })).toBe(2);
	});

	it('maps transform.error to Warning (4)', () => {
		expect(getSeverity('transform.error')).toBe(4);
	});

	it('maps deliver.retry to Warning (4)', () => {
		expect(getSeverity('deliver.retry')).toBe(4);
	});

	it('maps deliver.success to Informational (6)', () => {
		expect(getSeverity('deliver.success')).toBe(6);
	});

	it('maps route.match to Informational (6)', () => {
		expect(getSeverity('route.match')).toBe(6);
	});

	it('maps system.start to Informational (6)', () => {
		expect(getSeverity('system.start')).toBe(6);
	});

	it('maps system.stop to Informational (6)', () => {
		expect(getSeverity('system.stop')).toBe(6);
	});

	it('maps source.emit to Debug (7)', () => {
		expect(getSeverity('source.emit')).toBe(7);
	});

	it('maps transform.start to Debug (7)', () => {
		expect(getSeverity('transform.start')).toBe(7);
	});

	it('maps route.no_match to Debug (7)', () => {
		expect(getSeverity('route.no_match')).toBe(7);
	});
});

// ─── RFC 5424 Formatting ─────────────────────────────────────────────────────

describe('formatRfc5424()', () => {
	it('produces valid RFC 5424 message with structured data', () => {
		const entry = makeEntry();
		const msg = formatRfc5424(entry, 16, 'orgloop', 'myhost', true);

		// PRI = 16 * 8 + 6 (Info) = 134
		expect(msg).toMatch(/^<134>1 /);
		expect(msg).toContain('2025-01-15T10:30:00.000Z');
		expect(msg).toContain('myhost');
		expect(msg).toContain('orgloop');
		expect(msg).toContain(String(process.pid));
		expect(msg).toContain('deliver.success');
		expect(msg).toContain('[orgloop@49999');
		expect(msg).toContain('event_id="evt_abc123"');
		expect(msg).toContain('trace_id="trc_xyz789"');
		expect(msg).toContain('source="github"');
		expect(msg).toContain('event_type="resource.changed"');
		expect(msg).toContain('duration_ms="89"');
	});

	it('uses NILVALUE for structured data when disabled', () => {
		const entry = makeEntry();
		const msg = formatRfc5424(entry, 16, 'orgloop', 'myhost', false);

		expect(msg).toContain(' - '); // NILVALUE for SD
		expect(msg).not.toContain('[orgloop@49999');
	});

	it('calculates PRI correctly for different facilities and severities', () => {
		// daemon (3) + error (3) = 27
		const entry = makeEntry({ phase: 'deliver.failure' });
		const msg = formatRfc5424(entry, 3, 'orgloop', 'myhost', false);
		expect(msg).toMatch(/^<27>1 /);
	});

	it('includes error in structured data and message', () => {
		const entry = makeEntry({ phase: 'deliver.failure', error: 'connection refused' });
		const msg = formatRfc5424(entry, 16, 'orgloop', 'myhost', true);

		expect(msg).toContain('error="connection refused"');
	});

	it('escapes special characters in structured data values', () => {
		const entry = makeEntry({ error: 'has "quotes" and \\backslash and ]bracket' });
		const msg = formatRfc5424(entry, 16, 'orgloop', 'myhost', true);

		// RFC 5424: ", \, and ] must be escaped with backslash
		expect(msg).toContain('error="has \\"quotes\\" and \\\\backslash and \\]bracket"');
	});

	it('includes optional fields when present', () => {
		const entry = makeEntry({
			target: 'openclaw',
			route: 'pr-review',
			transform: 'filter',
		});
		const msg = formatRfc5424(entry, 16, 'orgloop', 'myhost', true);

		expect(msg).toContain('target="openclaw"');
		expect(msg).toContain('route="pr-review"');
		expect(msg).toContain('transform="filter"');
	});

	it('handles minimal entry without optional fields', () => {
		const entry: LogEntry = {
			timestamp: '2025-01-15T10:30:00.000Z',
			event_id: 'evt_min',
			trace_id: 'trc_min',
			phase: 'system.start',
		};
		const msg = formatRfc5424(entry, 16, 'orgloop', 'myhost', true);

		expect(msg).toMatch(/^<134>1 /);
		expect(msg).toContain('system.start');
		expect(msg).toContain('event_id="evt_min"');
	});

	it('falls back to current time when timestamp is empty', () => {
		const entry = makeEntry({ timestamp: '' });
		const msg = formatRfc5424(entry, 16, 'orgloop', 'myhost', false);
		// Should not contain empty timestamp, should have an ISO string
		expect(msg).toMatch(/^<134>1 \d{4}-\d{2}-\d{2}T/);
	});
});

// ─── SyslogLogger with Mock Transport ────────────────────────────────────────

describe('SyslogLogger', () => {
	it('sends RFC 5424 messages on log()', async () => {
		const mockTransport = new MockTransport();
		const logger = new SyslogLogger();
		await logger.init({ _transport: mockTransport });

		await logger.log(makeEntry());

		expect(mockTransport.messages).toHaveLength(1);
		const sent = mockTransport.messages[0];
		expect(sent).toMatch(/^<134>1 /); // local0 (16) * 8 + info (6) = 134
		expect(sent).toContain('deliver.success');
	});

	it('respects custom facility', async () => {
		const mockTransport = new MockTransport();
		const logger = new SyslogLogger();
		await logger.init({ facility: 'daemon', _transport: mockTransport });

		await logger.log(makeEntry());

		const sent = mockTransport.messages[0];
		// daemon (3) * 8 + info (6) = 30
		expect(sent).toMatch(/^<30>1 /);
	});

	it('respects custom app_name', async () => {
		const mockTransport = new MockTransport();
		const logger = new SyslogLogger();
		await logger.init({ app_name: 'my-org', _transport: mockTransport });

		await logger.log(makeEntry());

		const sent = mockTransport.messages[0];
		expect(sent).toContain(' my-org ');
	});

	it('disables structured data when configured', async () => {
		const mockTransport = new MockTransport();
		const logger = new SyslogLogger();
		await logger.init({ include_structured_data: false, _transport: mockTransport });

		await logger.log(makeEntry());

		const sent = mockTransport.messages[0];
		expect(sent).not.toContain('[orgloop@49999');
	});

	it('does not throw when transport is null', async () => {
		const logger = new SyslogLogger();
		// Don't call init — transport is null
		await expect(logger.log(makeEntry())).resolves.toBeUndefined();
	});

	it('does not throw when transport.send fails', async () => {
		const mockTransport = new MockTransport();
		mockTransport.sendError = true;
		const logger = new SyslogLogger();
		await logger.init({ _transport: mockTransport });

		// Should not throw — loggers must be error-resilient
		await expect(logger.log(makeEntry())).resolves.toBeUndefined();
	});

	it('shuts down and closes transport', async () => {
		const mockTransport = new MockTransport();
		const logger = new SyslogLogger();
		await logger.init({ _transport: mockTransport });

		await logger.shutdown();
		expect(mockTransport.closed).toBe(true);
	});

	it('shutdown is idempotent when transport is null', async () => {
		const logger = new SyslogLogger();
		// Don't call init
		await expect(logger.shutdown()).resolves.toBeUndefined();
	});

	it('handles all phases without errors', async () => {
		const mockTransport = new MockTransport();
		const logger = new SyslogLogger();
		await logger.init({ _transport: mockTransport });

		const phases: LogPhase[] = [
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

		for (const phase of phases) {
			await expect(logger.log(makeEntry({ phase }))).resolves.toBeUndefined();
		}

		expect(mockTransport.messages).toHaveLength(phases.length);

		await logger.shutdown();
	});

	it('maps error phases to higher severity PRI values', async () => {
		const mockTransport = new MockTransport();
		const logger = new SyslogLogger();
		await logger.init({ _transport: mockTransport });

		// deliver.failure -> severity 3 -> PRI = 16*8 + 3 = 131
		await logger.log(makeEntry({ phase: 'deliver.failure' }));
		expect(mockTransport.messages[0]).toMatch(/^<131>1 /);

		// system.error with fatal -> severity 2 -> PRI = 16*8 + 2 = 130
		await logger.log(makeEntry({ phase: 'system.error', metadata: { fatal: true } }));
		expect(mockTransport.messages[1]).toMatch(/^<130>1 /);

		// source.emit -> severity 7 -> PRI = 16*8 + 7 = 135
		await logger.log(makeEntry({ phase: 'source.emit' }));
		expect(mockTransport.messages[2]).toMatch(/^<135>1 /);

		await logger.shutdown();
	});

	it('flush resolves immediately', async () => {
		const mockTransport = new MockTransport();
		const logger = new SyslogLogger();
		await logger.init({ _transport: mockTransport });

		await expect(logger.flush()).resolves.toBeUndefined();

		await logger.shutdown();
	});

	it('includes structured data by default', async () => {
		const mockTransport = new MockTransport();
		const logger = new SyslogLogger();
		await logger.init({ _transport: mockTransport });

		await logger.log(makeEntry());

		expect(mockTransport.messages[0]).toContain('[orgloop@49999');
		expect(mockTransport.messages[0]).toContain('event_id="evt_abc123"');

		await logger.shutdown();
	});
});
