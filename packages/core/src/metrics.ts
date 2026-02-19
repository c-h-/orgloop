/**
 * Prometheus metrics for OrgLoop runtime.
 *
 * Opt-in: only starts if ORGLOOP_METRICS_PORT is set.
 * Exposes standard Prometheus metrics on GET /metrics.
 */

import { createServer, type Server } from 'node:http';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

export const DEFAULT_METRICS_PORT = 9100;

export interface MetricsServerOptions {
	/** Port to listen on (default: ORGLOOP_METRICS_PORT or 9100) */
	port?: number;
}

export class MetricsServer {
	private readonly registry: Registry;
	private server: Server | null = null;
	private startedAtMs = 0;
	private uptimeInterval: ReturnType<typeof setInterval> | null = null;

	// ─── Metrics ─────────────────────────────────────────────────────────────

	readonly eventsRouted: Counter;
	readonly eventProcessingSeconds: Histogram;
	readonly connectorErrors: Counter;
	readonly uptimeSeconds: Gauge;
	readonly connectedSources: Gauge;

	constructor() {
		this.registry = new Registry();

		// Collect default Node.js metrics (GC, memory, event loop, etc.)
		collectDefaultMetrics({ register: this.registry });

		this.eventsRouted = new Counter({
			name: 'orgloop_events_routed_total',
			help: 'Total number of events routed to actors',
			labelNames: ['route', 'connector'] as const,
			registers: [this.registry],
		});

		this.eventProcessingSeconds = new Histogram({
			name: 'orgloop_event_processing_seconds',
			help: 'Time spent processing events through the routing pipeline',
			labelNames: ['route'] as const,
			buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
			registers: [this.registry],
		});

		this.connectorErrors = new Counter({
			name: 'orgloop_connector_errors_total',
			help: 'Total number of connector errors (source poll failures, delivery failures)',
			labelNames: ['connector'] as const,
			registers: [this.registry],
		});

		this.uptimeSeconds = new Gauge({
			name: 'orgloop_uptime_seconds',
			help: 'Seconds since the runtime started',
			registers: [this.registry],
		});

		this.connectedSources = new Gauge({
			name: 'orgloop_connected_sources',
			help: 'Number of currently connected (registered) sources',
			registers: [this.registry],
		});
	}

	async start(options?: MetricsServerOptions): Promise<void> {
		const port =
			options?.port ??
			(process.env.ORGLOOP_METRICS_PORT
				? Number.parseInt(process.env.ORGLOOP_METRICS_PORT, 10)
				: DEFAULT_METRICS_PORT);

		this.startedAtMs = Date.now();

		// Update uptime gauge every 5 seconds
		this.uptimeInterval = setInterval(() => {
			this.uptimeSeconds.set((Date.now() - this.startedAtMs) / 1000);
		}, 5_000);
		if (this.uptimeInterval.unref) {
			this.uptimeInterval.unref();
		}
		// Set initial value
		this.uptimeSeconds.set(0);

		return new Promise((resolve, reject) => {
			this.server = createServer(async (req, res) => {
				if (req.url === '/metrics' && req.method === 'GET') {
					try {
						const metrics = await this.registry.metrics();
						res.writeHead(200, { 'Content-Type': this.registry.contentType });
						res.end(metrics);
					} catch {
						res.writeHead(500);
						res.end('Error collecting metrics');
					}
				} else {
					res.writeHead(404);
					res.end('Not found');
				}
			});

			this.server.on('error', reject);
			this.server.listen(port, '127.0.0.1', () => {
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		if (this.uptimeInterval) {
			clearInterval(this.uptimeInterval);
			this.uptimeInterval = null;
		}

		const srv = this.server;
		if (!srv) return;

		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				srv.closeAllConnections();
			}, 5_000);
			srv.close(() => {
				clearTimeout(timeout);
				this.server = null;
				resolve();
			});
		});
	}

	/** Whether the metrics server is currently running. */
	isStarted(): boolean {
		return this.server !== null;
	}

	/** Returns the port the metrics server is listening on, or null. */
	port(): number | null {
		if (!this.server) return null;
		const addr = this.server.address();
		if (addr && typeof addr === 'object') return addr.port;
		return null;
	}
}
