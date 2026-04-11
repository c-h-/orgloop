/**
 * Inbox REST API — registers /api/inbox/* endpoints on the WebhookServer.
 *
 *   GET /api/inbox/drain?session_key=<key>&limit=100  — drain pending events
 *   GET /api/inbox/status?session_key=<key>           — check pending count
 */

import type { Runtime } from './runtime.js';

export function registerInboxApi(runtime: Runtime): void {
	const server = runtime.getWebhookServer();
	const manager = runtime.getInboxManager();

	if (!manager) return; // Inbox not enabled — no endpoints

	// GET /api/inbox/drain?session_key=<key>&limit=100
	server.registerApiHandler('inbox/drain', async (query) => {
		const sessionKey = query.get('session_key');
		if (!sessionKey) {
			return { error: 'Missing required parameter: session_key' };
		}
		const limitStr = query.get('limit');
		const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;
		return manager.drain(sessionKey, limit);
	});

	// GET /api/inbox/status?session_key=<key>
	server.registerApiHandler('inbox/status', async (query) => {
		const sessionKey = query.get('session_key');
		if (!sessionKey) {
			return { error: 'Missing required parameter: session_key' };
		}
		return { pending: await manager.pending(sessionKey) };
	});
}
