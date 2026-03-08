/**
 * OpenClaw actor (target) connector — delivers events to OpenClaw agent via HTTP webhook.
 */

import type {
	ActorConfig,
	ActorConnector,
	DeliveryResult,
	HttpAgent,
	OrgLoopEvent,
	RouteDeliveryConfig,
} from '@orgloop/sdk';
import { closeHttpAgent, createFetchWithKeepAlive, createHttpAgent } from '@orgloop/sdk';

/** Resolve env var references like ${OPENCLAW_AUTH_TOKEN} */
function resolveEnvVar(value: string): string {
	const match = value.match(/^\$\{(.+)\}$/);
	if (match) {
		const envValue = process.env[match[1]];
		if (!envValue) {
			throw new Error(`Environment variable ${match[1]} is not set`);
		}
		return envValue;
	}
	return value;
}

/**
 * Resolve a dot-path (e.g. "payload.pr_number") against a nested object.
 * Returns undefined if any segment is missing.
 */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
	let current: unknown = obj;
	for (const segment of path.split('.')) {
		if (current == null || typeof current !== 'object') return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/**
 * Interpolate `{{dot.path}}` placeholders in a template string using event fields.
 *
 * Uses double-brace syntax to avoid collision with OrgLoop's `${...}` env var
 * substitution in YAML config. Paths are resolved against the full event object:
 * top-level fields, provenance.*, and payload.* are all reachable.
 * Unresolved placeholders are replaced with "unknown" to keep session keys stable.
 *
 * Examples:
 *   "orgloop:pr-review:{{payload.pr_number}}"  → "orgloop:pr-review:42"
 *   "orgloop:{{source}}:{{provenance.author}}"  → "orgloop:github:alice"
 */
function interpolateTemplate(template: string, event: OrgLoopEvent): string {
	return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
		const value = resolvePath(event as unknown as Record<string, unknown>, path.trim());
		if (value === undefined || value === null) return 'unknown';
		return String(value);
	});
}

interface OpenClawConfig {
	base_url?: string;
	auth_token_env?: string;
	agent_id?: string;
	default_channel?: string;
	default_to?: string;
}

export class OpenClawTarget implements ActorConnector {
	readonly id = 'openclaw';
	private baseUrl = 'http://127.0.0.1:18789';
	private authToken?: string;
	private agentId?: string;
	private defaultChannel?: string;
	private defaultTo?: string;
	private httpAgent: HttpAgent | null = null;
	private fetch: typeof globalThis.fetch = globalThis.fetch;

	async init(config: ActorConfig): Promise<void> {
		const cfg = config.config as unknown as OpenClawConfig;
		this.baseUrl = cfg.base_url ?? 'http://127.0.0.1:18789';
		this.agentId = cfg.agent_id;
		this.defaultChannel = cfg.default_channel;
		this.defaultTo = cfg.default_to;

		if (cfg.auth_token_env) {
			this.authToken = resolveEnvVar(cfg.auth_token_env);
		}

		this.httpAgent = createHttpAgent();
		this.fetch = createFetchWithKeepAlive(this.httpAgent);
	}

	async deliver(event: OrgLoopEvent, routeConfig: RouteDeliveryConfig): Promise<DeliveryResult> {
		const url = `${this.baseUrl}/hooks/agent`;

		const rawSessionKey =
			(routeConfig.session_key as string) ?? `orgloop:${event.source}:${event.type}`;
		const normalSessionKey = interpolateTemplate(rawSessionKey, event);

		const message = this.buildMessage(event, routeConfig);

		// #66 — Dynamic threadId from route config
		const rawThreadId = routeConfig.thread_id as string | undefined;
		const threadId = rawThreadId ? interpolateTemplate(rawThreadId, event) : undefined;

		// #91 — Callback-first delivery: check event payload for callback metadata
		const callbackSessionKey = this.resolveCallbackSessionKey(event);

		if (callbackSessionKey) {
			const callbackResult = await this.postToAgent(url, {
				message,
				sessionKey: callbackSessionKey,
				agentId: this.agentId,
				wakeMode: (routeConfig.wake_mode as string) ?? 'now',
				deliver: routeConfig.deliver ?? false,
				channel: (routeConfig.channel as string) ?? this.defaultChannel,
				to: (routeConfig.to as string) ?? this.defaultTo,
				...(threadId !== undefined ? { threadId } : {}),
			});
			if (callbackResult.status === 'delivered') {
				return callbackResult;
			}
			// Callback delivery failed — fall back to normal delivery
		}

		return this.postToAgent(url, {
			message,
			sessionKey: normalSessionKey,
			agentId: this.agentId,
			wakeMode: (routeConfig.wake_mode as string) ?? 'now',
			deliver: routeConfig.deliver ?? false,
			channel: (routeConfig.channel as string) ?? this.defaultChannel,
			to: (routeConfig.to as string) ?? this.defaultTo,
			...(threadId !== undefined ? { threadId } : {}),
		});
	}

	/**
	 * Extract callback session key from event payload metadata.
	 * Checks: payload.meta.openclaw_callback_session_key, then payload.session.meta.openclaw_callback_session_key
	 */
	private resolveCallbackSessionKey(event: OrgLoopEvent): string | undefined {
		const payload = event.payload as Record<string, unknown>;

		// Check payload.meta.openclaw_callback_session_key
		const meta = payload.meta as Record<string, unknown> | undefined;
		if (
			meta?.openclaw_callback_session_key &&
			typeof meta.openclaw_callback_session_key === 'string'
		) {
			return meta.openclaw_callback_session_key;
		}

		// Check payload.session.meta.openclaw_callback_session_key
		const session = payload.session as Record<string, unknown> | undefined;
		const sessionMeta = session?.meta as Record<string, unknown> | undefined;
		if (
			sessionMeta?.openclaw_callback_session_key &&
			typeof sessionMeta.openclaw_callback_session_key === 'string'
		) {
			return sessionMeta.openclaw_callback_session_key;
		}

		return undefined;
	}

	private async postToAgent(url: string, body: Record<string, unknown>): Promise<DeliveryResult> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		if (this.authToken) {
			headers.Authorization = `Bearer ${this.authToken}`;
		}

		try {
			const response = await this.fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
			});

			if (response.ok) {
				return { status: 'delivered' };
			}

			if (response.status === 429) {
				return {
					status: 'error',
					error: new Error('OpenClaw rate limited (429)'),
				};
			}

			if (response.status >= 400 && response.status < 500) {
				return {
					status: 'rejected',
					error: new Error(`OpenClaw rejected: ${response.status} ${response.statusText}`),
				};
			}

			return {
				status: 'error',
				error: new Error(`OpenClaw error: ${response.status} ${response.statusText}`),
			};
		} catch (err) {
			return {
				status: 'error',
				error: err instanceof Error ? err : new Error(String(err)),
			};
		}
	}

	async shutdown(): Promise<void> {
		if (this.httpAgent) {
			await closeHttpAgent(this.httpAgent);
			this.httpAgent = null;
		}
	}

	/**
	 * Build the message string for OpenClaw from an OrgLoop event.
	 *
	 * Structure:
	 *   1. Header line: [source] type (platform_event) by author
	 *   2. Event context: provenance fields (url, issue_id, etc.)
	 *   3. Event payload: the actual data (comment body, ticket title, etc.)
	 *   4. Instructions: launch_prompt from route config (SOP)
	 */
	private buildMessage(event: OrgLoopEvent, routeConfig: RouteDeliveryConfig): string {
		const sections: string[] = [];

		// 1. Header line
		const header: string[] = [`[${event.source}] ${event.type}`];
		if (event.provenance.platform_event) {
			header.push(`(${event.provenance.platform_event})`);
		}
		if (event.provenance.author) {
			header.push(`by ${event.provenance.author}`);
		}
		sections.push(header.join(' '));

		// 2. Event context from provenance (skip standard fields already in header)
		const skipProvenance = new Set(['platform', 'platform_event', 'author', 'author_type']);
		const contextEntries = Object.entries(event.provenance).filter(
			([k, v]) => !skipProvenance.has(k) && v !== undefined,
		);
		if (contextEntries.length > 0) {
			const lines = contextEntries.map(([k, v]) => `  ${k}: ${v}`);
			sections.push(`Context:\n${lines.join('\n')}`);
		}

		// 3. Event payload — the actual data the LLM needs to act on
		const payloadEntries = Object.entries(event.payload);
		if (payloadEntries.length > 0) {
			const lines = payloadEntries.map(([k, v]) => {
				const val = typeof v === 'string' ? v : JSON.stringify(v);
				return `  ${k}: ${val}`;
			});
			sections.push(`Payload:\n${lines.join('\n')}`);
		}

		// 4. Instructions from route config
		if (routeConfig.launch_prompt) {
			sections.push(`Instructions:\n${routeConfig.launch_prompt}`);
		}

		return sections.join('\n\n');
	}
}
