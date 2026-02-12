/**
 * WebhookServer — lightweight HTTP server for webhook-based sources.
 *
 * Listens on localhost only. Routes POST /webhook/:sourceId to registered handlers.
 * Control API endpoints are available when a RuntimeControl is set.
 * No auth, no CORS — just local event ingestion.
 */

import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { OrgLoopEvent, WebhookHandler } from '@orgloop/sdk';

export const DEFAULT_HTTP_PORT = 4800;

/** Interface for runtime control — avoids circular dependency with Runtime class. */
export interface RuntimeControl {
	status(): unknown;
	loadModule(config: unknown): Promise<unknown>;
	unloadModule(name: string): Promise<void>;
	reloadModule(name: string): Promise<void>;
	listModules(): unknown[];
	getModuleStatus(name: string): unknown;
	stop(): Promise<void>;
}

export class WebhookServer {
	private readonly handlers: Map<string, WebhookHandler>;
	private readonly onEvent: (event: OrgLoopEvent) => Promise<void>;
	private server: ReturnType<typeof createServer> | null = null;
	private _runtime: RuntimeControl | null = null;

	constructor(
		onEvent: (event: OrgLoopEvent) => Promise<void>,
		handlers?: Map<string, WebhookHandler>,
	) {
		this.onEvent = onEvent;
		this.handlers = handlers ?? new Map();
	}

	set runtime(rt: RuntimeControl) {
		this._runtime = rt;
	}

	addHandler(sourceId: string, handler: WebhookHandler): void {
		this.handlers.set(sourceId, handler);
	}

	removeHandler(sourceId: string): void {
		this.handlers.delete(sourceId);
	}

	async start(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server = createServer((req, res) => {
				void this.handleRequest(req, res);
			});

			this.server.on('error', reject);
			this.server.listen(port, '127.0.0.1', () => {
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		const srv = this.server;
		if (!srv) return;
		return new Promise((resolve) => {
			srv.close(() => {
				this.server = null;
				resolve();
			});
		});
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
		const parts = url.pathname.split('/').filter(Boolean);

		// Control API routes
		if (parts[0] === 'control') {
			await this.handleControlRequest(req, res, parts.slice(1));
			return;
		}

		// Route: POST /webhook/:sourceId
		if (parts.length !== 2 || parts[0] !== 'webhook') {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Not found' }));
			return;
		}

		const sourceId = parts[1];

		if (req.method !== 'POST') {
			res.writeHead(405, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Method not allowed' }));
			return;
		}

		const handler = this.handlers.get(sourceId);
		if (!handler) {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: `Unknown source: ${sourceId}` }));
			return;
		}

		try {
			const events = await handler(req, res);
			for (const event of events) {
				await this.onEvent(event);
			}
		} catch (err) {
			// If the handler hasn't written a response yet, send 500
			if (!res.headersSent) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }));
			}
		}
	}

	private async handleControlRequest(
		req: IncomingMessage,
		res: ServerResponse,
		parts: string[],
	): Promise<void> {
		if (!this._runtime) {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Control API not available' }));
			return;
		}

		const route = parts.join('/');

		try {
			// GET /control/status
			if (req.method === 'GET' && route === 'status') {
				const status = this._runtime.status();
				this.jsonResponse(res, 200, status);
				return;
			}

			// POST /control/module/load
			if (req.method === 'POST' && route === 'module/load') {
				const body = await this.readBody(req);
				const result = await this._runtime.loadModule(body);
				this.jsonResponse(res, 200, result);
				return;
			}

			// POST /control/module/unload
			if (req.method === 'POST' && route === 'module/unload') {
				const body = await this.readBody(req);
				await this._runtime.unloadModule(body.name as string);
				this.jsonResponse(res, 200, { ok: true });
				return;
			}

			// POST /control/module/reload
			if (req.method === 'POST' && route === 'module/reload') {
				const body = await this.readBody(req);
				await this._runtime.reloadModule(body.name as string);
				this.jsonResponse(res, 200, { ok: true });
				return;
			}

			// GET /control/module/list
			if (req.method === 'GET' && route === 'module/list') {
				const modules = this._runtime.listModules();
				this.jsonResponse(res, 200, modules);
				return;
			}

			// GET /control/module/status/:name
			if (req.method === 'GET' && parts[0] === 'module' && parts[1] === 'status' && parts[2]) {
				const name = parts[2];
				const status = this._runtime.getModuleStatus(name);
				if (status == null) {
					this.jsonResponse(res, 404, { error: `Module not found: ${name}` });
				} else {
					this.jsonResponse(res, 200, status);
				}
				return;
			}

			// POST /control/shutdown
			if (req.method === 'POST' && route === 'shutdown') {
				this.jsonResponse(res, 200, { ok: true });
				await this._runtime.stop();
				return;
			}

			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Not found' }));
		} catch (err) {
			if (!res.headersSent) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }));
			}
		}
	}

	private jsonResponse(res: ServerResponse, status: number, data: unknown): void {
		res.writeHead(status, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(data));
	}

	private readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => {
				try {
					const text = Buffer.concat(chunks).toString('utf-8');
					resolve(JSON.parse(text) as Record<string, unknown>);
				} catch (err) {
					reject(err);
				}
			});
			req.on('error', reject);
		});
	}
}
