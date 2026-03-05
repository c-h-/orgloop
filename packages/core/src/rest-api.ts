/**
 * REST API — registers /api/* endpoints on the WebhookServer.
 *
 * Provides structured JSON endpoints mirroring CLI functionality:
 *   GET /api/status   — runtime health, uptime, source status, event counts
 *   GET /api/routes   — configured routes with fire counts
 *   GET /api/events   — recent event log with filtering
 *   GET /api/sources  — per-source connector detail
 *   GET /api/metrics  — Prometheus-format metrics
 *   GET /api/doctor   — structured doctor output (registered externally)
 */

import type { Runtime } from './runtime.js';

/**
 * Register all REST API endpoints on the runtime's webhook server.
 *
 * The /api/doctor endpoint is NOT registered here — it requires CLI-level
 * config resolution. Register it separately via runtime.getWebhookServer().registerApiHandler().
 */
export function registerRestApi(runtime: Runtime): void {
	const server = runtime.getWebhookServer();

	// GET /api/status
	server.registerApiHandler('status', async () => {
		const runtimeStatus = runtime.status();
		const sources = runtime.getSourceDetails();

		// Determine overall health from source statuses
		const hasUnhealthy = sources.some((s) => s.status === 'unhealthy');
		const hasDegraded = sources.some((s) => s.status === 'degraded');
		let health: 'ok' | 'degraded' | 'error' = 'ok';
		if (hasUnhealthy) health = 'error';
		else if (hasDegraded) health = 'degraded';

		return {
			health,
			running: runtimeStatus.running,
			pid: runtimeStatus.pid,
			uptime_ms: runtimeStatus.uptime_ms,
			http_port: runtimeStatus.httpPort,
			modules: runtimeStatus.modules.map((m) => ({
				name: m.name,
				state: m.state,
				sources: m.sources,
				routes: m.routes,
				actors: m.actors,
				uptime_ms: m.uptime_ms,
			})),
			sources: sources.map((s) => ({
				id: s.id,
				connector: s.connector,
				status: s.status,
				event_count: s.event_count,
				last_event: s.last_event,
			})),
		};
	});

	// GET /api/routes
	server.registerApiHandler('routes', async () => {
		return runtime.getRouteDetails();
	});

	// GET /api/events?from=&to=&source=&route=&limit=
	server.registerApiHandler('events', async (query) => {
		const from = query.get('from') ?? undefined;
		const to = query.get('to') ?? undefined;
		const source = query.get('source') ?? undefined;
		const route = query.get('route') ?? undefined;
		const limitStr = query.get('limit');
		const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;

		return runtime.queryEvents({ from, to, source, route, limit });
	});

	// GET /api/sources
	server.registerApiHandler('sources', async () => {
		return runtime.getSourceDetails();
	});

	// GET /api/metrics
	server.registerApiHandler('metrics', async () => {
		const text = await runtime.getMetricsText();
		if (text === null) {
			return { error: 'Metrics not enabled. Set ORGLOOP_METRICS_PORT or metricsPort option.' };
		}
		return text;
	});
}
