/**
 * Syslog logger — RFC 5424 formatted messages for enterprise/unix deployments.
 *
 * Supports UDP (fire-and-forget), TCP (reliable, newline-delimited),
 * and Unix socket transports. Zero external dependencies.
 */

import { type Socket as UdpSocket, createSocket } from 'node:dgram';
import { type Socket as TcpSocket, createConnection } from 'node:net';
import { hostname } from 'node:os';
import type { LogEntry, LogPhase, Logger } from '@orgloop/sdk';

// ─── RFC 5424 Facilities ─────────────────────────────────────────────────────

const FACILITY_MAP: Record<string, number> = {
	kern: 0,
	user: 1,
	mail: 2,
	daemon: 3,
	auth: 4,
	syslog: 5,
	lpr: 6,
	news: 7,
	uucp: 8,
	cron: 9,
	authpriv: 10,
	ftp: 11,
	local0: 16,
	local1: 17,
	local2: 18,
	local3: 19,
	local4: 20,
	local5: 21,
	local6: 22,
	local7: 23,
};

// ─── RFC 5424 Severity Mapping ───────────────────────────────────────────────

/** Map OrgLoop phases to RFC 5424 severity levels */
const PHASE_SEVERITY: Record<LogPhase, number> = {
	'system.error': 3, // Error (may be upgraded to Critical via metadata)
	'deliver.failure': 3, // Error
	'transform.error': 4, // Warning
	'transform.error_drop': 4, // Warning
	'transform.error_halt': 3, // Error
	'deliver.retry': 4, // Warning
	'deliver.success': 6, // Informational
	'deliver.attempt': 6, // Informational
	'route.match': 6, // Informational
	'transform.pass': 6, // Informational
	'transform.drop': 6, // Informational
	'system.start': 6, // Informational
	'system.stop': 6, // Informational
	'source.emit': 7, // Debug
	'transform.start': 7, // Debug
	'route.no_match': 7, // Debug
	'source.circuit_open': 4, // Warning
	'source.circuit_retry': 6, // Informational
	'source.circuit_close': 6, // Informational
	'module.loading': 6, // Informational
	'module.active': 6, // Informational
	'module.unloading': 6, // Informational
	'module.removed': 6, // Informational
	'module.error': 3, // Error
	'runtime.start': 6, // Informational
	'runtime.stop': 6, // Informational
};

/** Get severity for a phase, with optional fatal upgrade */
export function getSeverity(phase: LogPhase, metadata?: Record<string, unknown>): number {
	const base = PHASE_SEVERITY[phase] ?? 6;
	// Upgrade system.error to Critical if fatal flag is set
	if (phase === 'system.error' && metadata?.fatal === true) {
		return 2;
	}
	return base;
}

// ─── RFC 5424 Message Formatting ─────────────────────────────────────────────

/**
 * Escape structured data param values per RFC 5424 section 6.3.3:
 * `"`, `\`, and `]` must be escaped with backslash.
 */
function escapeSDValue(value: string): string {
	return value.replace(/["\\\]]/g, (ch) => `\\${ch}`);
}

/**
 * Build an RFC 5424 syslog message.
 *
 * Format: <PRI>VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID SP SD SP MSG
 */
export function formatRfc5424(
	entry: LogEntry,
	facility: number,
	appName: string,
	hostName: string,
	includeStructuredData: boolean,
): string {
	const severity = getSeverity(entry.phase, entry.metadata);
	const pri = facility * 8 + severity;
	const version = 1;
	const timestamp = entry.timestamp || new Date().toISOString();
	const procId = String(process.pid);
	const msgId = entry.phase;

	// Build structured data
	let sd = '-';
	if (includeStructuredData) {
		const params: string[] = [];

		if (entry.event_id) params.push(`event_id="${escapeSDValue(entry.event_id)}"`);
		if (entry.trace_id) params.push(`trace_id="${escapeSDValue(entry.trace_id)}"`);
		if (entry.source) params.push(`source="${escapeSDValue(entry.source)}"`);
		if (entry.event_type) params.push(`event_type="${escapeSDValue(entry.event_type)}"`);
		if (entry.target) params.push(`target="${escapeSDValue(entry.target)}"`);
		if (entry.route) params.push(`route="${escapeSDValue(entry.route)}"`);
		if (entry.transform) params.push(`transform="${escapeSDValue(entry.transform)}"`);
		if (entry.duration_ms !== undefined) params.push(`duration_ms="${entry.duration_ms}"`);
		if (entry.error) params.push(`error="${escapeSDValue(entry.error)}"`);

		if (params.length > 0) {
			// Use Private Enterprise Number (PEN) range — 49999 is in the example range
			sd = `[orgloop@49999 ${params.join(' ')}]`;
		}
	}

	// Build human-readable message
	const msgParts: string[] = [entry.phase];
	if (entry.source) msgParts.push(entry.source);
	if (entry.event_type) msgParts.push(entry.event_type);
	if (entry.event_id) msgParts.push(entry.event_id);
	if (entry.error) msgParts.push(`error="${entry.error}"`);
	const msg = msgParts.join(' ');

	return `<${pri}>${version} ${timestamp} ${hostName} ${appName} ${procId} ${msgId} ${sd} ${msg}`;
}

// ─── Transport Interface ─────────────────────────────────────────────────────

export interface SyslogTransport {
	send(message: string): void;
	close(): Promise<void>;
}

// ─── UDP Transport ───────────────────────────────────────────────────────────

export class UdpTransport implements SyslogTransport {
	private socket: UdpSocket;
	private host: string;
	private port: number;

	constructor(host: string, port: number) {
		this.host = host;
		this.port = port;
		this.socket = createSocket('udp4');
		// Unref so the socket doesn't keep the process alive
		this.socket.unref();
	}

	send(message: string): void {
		const buf = Buffer.from(message, 'utf-8');
		this.socket.send(buf, 0, buf.length, this.port, this.host, () => {
			// Fire-and-forget — errors are silently ignored
		});
	}

	async close(): Promise<void> {
		return new Promise<void>((resolve) => {
			try {
				this.socket.close(() => resolve());
			} catch {
				resolve();
			}
		});
	}
}

// ─── TCP Transport ───────────────────────────────────────────────────────────

export class TcpTransport implements SyslogTransport {
	private socket: TcpSocket | null = null;
	private host: string;
	private port: number;
	private connecting = false;
	private closed = false;
	private buffer: string[] = [];

	constructor(host: string, port: number) {
		this.host = host;
		this.port = port;
		this.connect();
	}

	private connect(): void {
		if (this.closed || this.connecting) return;
		this.connecting = true;

		const socket = createConnection({ host: this.host, port: this.port }, () => {
			this.connecting = false;
			this.socket = socket;
			// Flush any buffered messages
			for (const msg of this.buffer.splice(0)) {
				this.writeToSocket(msg);
			}
		});

		socket.setKeepAlive(true);
		socket.unref();

		socket.on('error', () => {
			// Reconnect on error
			this.socket = null;
			this.connecting = false;
			if (!this.closed) {
				setTimeout(() => this.connect(), 1000);
			}
		});

		socket.on('close', () => {
			this.socket = null;
			this.connecting = false;
			if (!this.closed) {
				setTimeout(() => this.connect(), 1000);
			}
		});
	}

	private writeToSocket(message: string): void {
		try {
			// RFC 5425: TCP syslog uses newline-delimited messages
			this.socket?.write(`${message}\n`);
		} catch {
			// Silently drop on write failure
		}
	}

	send(message: string): void {
		if (this.socket && !this.socket.destroyed) {
			this.writeToSocket(message);
		} else {
			// Buffer during reconnection (bounded to prevent memory leak)
			if (this.buffer.length < 1000) {
				this.buffer.push(message);
			}
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		this.buffer.length = 0;
		return new Promise<void>((resolve) => {
			if (this.socket) {
				this.socket.end(() => resolve());
			} else {
				resolve();
			}
		});
	}
}

// ─── Unix Socket Transport ───────────────────────────────────────────────────

export class UnixTransport implements SyslogTransport {
	private socket: TcpSocket | null = null;
	private socketPath: string;
	private connecting = false;
	private closed = false;
	private buffer: string[] = [];

	constructor(socketPath: string) {
		this.socketPath = socketPath;
		this.connect();
	}

	private connect(): void {
		if (this.closed || this.connecting) return;
		this.connecting = true;

		const socket = createConnection({ path: this.socketPath }, () => {
			this.connecting = false;
			this.socket = socket;
			for (const msg of this.buffer.splice(0)) {
				this.writeToSocket(msg);
			}
		});

		socket.unref();

		socket.on('error', () => {
			this.socket = null;
			this.connecting = false;
			if (!this.closed) {
				setTimeout(() => this.connect(), 1000);
			}
		});

		socket.on('close', () => {
			this.socket = null;
			this.connecting = false;
			if (!this.closed) {
				setTimeout(() => this.connect(), 1000);
			}
		});
	}

	private writeToSocket(message: string): void {
		try {
			this.socket?.write(`${message}\n`);
		} catch {
			// Silently drop on write failure
		}
	}

	send(message: string): void {
		if (this.socket && !this.socket.destroyed) {
			this.writeToSocket(message);
		} else {
			if (this.buffer.length < 1000) {
				this.buffer.push(message);
			}
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		this.buffer.length = 0;
		return new Promise<void>((resolve) => {
			if (this.socket) {
				this.socket.end(() => resolve());
			} else {
				resolve();
			}
		});
	}
}

// ─── Syslog Logger ───────────────────────────────────────────────────────────

export interface SyslogLoggerConfig {
	transport?: 'udp' | 'tcp' | 'unix';
	host?: string;
	port?: number;
	path?: string;
	facility?: string;
	app_name?: string;
	include_structured_data?: boolean;
	/** Internal: override transport for testing */
	_transport?: SyslogTransport;
}

export class SyslogLogger implements Logger {
	readonly id = 'syslog';
	private transport: SyslogTransport | null = null;
	private facility = 16; // local0
	private appName = 'orgloop';
	private hostName = hostname();
	private includeStructuredData = true;

	async init(config: Record<string, unknown>): Promise<void> {
		const cfg = config as SyslogLoggerConfig;

		// Parse facility
		if (cfg.facility) {
			const num = FACILITY_MAP[cfg.facility];
			if (num !== undefined) {
				this.facility = num;
			}
		}

		if (cfg.app_name) this.appName = cfg.app_name;
		if (cfg.include_structured_data !== undefined) {
			this.includeStructuredData = cfg.include_structured_data;
		}

		// Use injected transport if provided (for testing)
		if (cfg._transport) {
			this.transport = cfg._transport;
			return;
		}

		// Create transport
		const transportType = cfg.transport ?? 'udp';
		const host = cfg.host ?? '127.0.0.1';
		const port = cfg.port ?? 514;

		switch (transportType) {
			case 'tcp':
				this.transport = new TcpTransport(host, port);
				break;
			case 'unix':
				this.transport = new UnixTransport(cfg.path ?? '/dev/log');
				break;
			default:
				this.transport = new UdpTransport(host, port);
				break;
		}
	}

	async log(entry: LogEntry): Promise<void> {
		try {
			if (!this.transport) return;

			const message = formatRfc5424(
				entry,
				this.facility,
				this.appName,
				this.hostName,
				this.includeStructuredData,
			);

			this.transport.send(message);
		} catch {
			// Loggers must not throw
		}
	}

	async flush(): Promise<void> {
		// UDP is fire-and-forget; TCP/Unix writes are synchronous from our perspective
	}

	async shutdown(): Promise<void> {
		if (this.transport) {
			await this.transport.close();
			this.transport = null;
		}
	}
}
