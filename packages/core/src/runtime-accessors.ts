/**
 * REST/data accessor helpers for Runtime.
 *
 * Extracted to keep runtime.ts focused on lifecycle + dispatch. These pure
 * helpers project the in-memory registry/health/route-stats into the shapes
 * the REST API and CLI commands consume.
 */

import type { ModuleInstance } from './module-instance.js';
import type { RouteStats } from './runtime.js';

export interface RouteDetail {
	name: string;
	module: string;
	when: { source: string; events: string[]; filter?: Record<string, unknown> };
	actor: string;
	sop_file?: string;
	fire_count: number;
	last_fired: string | null;
}

export interface SourceDetail {
	id: string;
	module: string;
	connector: string;
	type: 'webhook' | 'polling';
	status: string;
	last_event: string | null;
	event_count: number;
	poll_interval?: string;
}

export function buildRouteDetails(
	modules: ModuleInstance[],
	routeStats: ReadonlyMap<string, RouteStats>,
): RouteDetail[] {
	const out: RouteDetail[] = [];
	for (const mod of modules) {
		for (const route of mod.getRoutes()) {
			const stats = routeStats.get(route.name);
			out.push({
				name: route.name,
				module: mod.name,
				when: {
					source: route.when.source,
					events: route.when.events,
					...(route.when.filter ? { filter: route.when.filter } : {}),
				},
				actor: route.then.actor,
				...(route.with?.prompt_file ? { sop_file: route.with.prompt_file } : {}),
				fire_count: stats?.fireCount ?? 0,
				last_fired: stats?.lastFiredAt ?? null,
			});
		}
	}
	return out;
}

export function buildSourceDetails(modules: ModuleInstance[]): SourceDetail[] {
	const out: SourceDetail[] = [];
	for (const mod of modules) {
		for (const srcCfg of mod.config.sources) {
			const connector = mod.getSource(srcCfg.id);
			const health = mod.getHealthState(srcCfg.id);
			const isWebhook = connector && typeof connector.webhook === 'function';
			out.push({
				id: srcCfg.id,
				module: mod.name,
				connector: srcCfg.connector,
				type: isWebhook ? 'webhook' : 'polling',
				status: health?.status ?? 'unknown',
				last_event: health?.lastSuccessfulPoll ?? null,
				event_count: health?.totalEventsEmitted ?? 0,
				...(srcCfg.poll?.interval ? { poll_interval: srcCfg.poll.interval } : {}),
			});
		}
	}
	return out;
}
