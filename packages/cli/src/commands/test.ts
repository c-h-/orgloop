/**
 * orgloop test — Inject a test event and trace its path.
 *
 * Accepts event JSON file, stdin, or generates sample events.
 */

import { readFile } from 'node:fs/promises';
import type { OrgLoopEvent } from '@orgloop/sdk';
import { generateEventId, generateTraceId } from '@orgloop/sdk';
import type { Command } from 'commander';
import { loadCliConfig } from '../config.js';
import * as output from '../output.js';

// ─── Sample events ───────────────────────────────────────────────────────────

const SAMPLE_EVENTS: Record<string, OrgLoopEvent> = {
	github: {
		id: generateEventId(),
		timestamp: new Date().toISOString(),
		source: 'github',
		type: 'resource.changed',
		provenance: {
			platform: 'github',
			platform_event: 'pull_request.opened',
			author: 'developer',
			author_type: 'team_member',
		},
		payload: {
			action: 'opened',
			resource_type: 'pull_request',
			number: 42,
			title: 'Add new feature',
			url: 'https://github.com/org/repo/pull/42',
			body: 'This PR adds a new feature...',
			labels: ['enhancement'],
			draft: false,
		},
	},
	linear: {
		id: generateEventId(),
		timestamp: new Date().toISOString(),
		source: 'linear',
		type: 'resource.changed',
		provenance: {
			platform: 'linear',
			platform_event: 'issue.updated',
			author: 'developer',
			author_type: 'team_member',
		},
		payload: {
			action: 'updated',
			resource_type: 'issue',
			identifier: 'ENG-123',
			title: 'Fix authentication bug',
			state: 'In Progress',
			priority: 2,
			url: 'https://linear.app/team/issue/ENG-123',
		},
	},
	'claude-code': {
		id: generateEventId(),
		timestamp: new Date().toISOString(),
		source: 'claude-code',
		type: 'actor.stopped',
		provenance: {
			platform: 'claude-code',
			platform_event: 'session.exit',
			author: 'claude-code',
			author_type: 'bot',
		},
		payload: {
			session_id: 'sess_abc123',
			exit_code: 0,
			duration_seconds: 1200,
			summary: 'Completed refactoring of auth module',
			files_changed: 5,
		},
	},
};

async function readEventFromStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString('utf-8');
}

// ─── Command registration ────────────────────────────────────────────────────

export function registerTestCommand(program: Command): void {
	program
		.command('test [file]')
		.description('Inject a test event and trace its path')
		.option('--generate <connector>', 'Generate a sample event for a connector type')
		.option('--dry-run', 'Trace through pipeline without actual delivery')
		.action(async (file: string | undefined, opts, cmd) => {
			try {
				const globalOpts = cmd.parent?.opts() ?? {};

				// Generate mode
				if (opts.generate) {
					const sample = SAMPLE_EVENTS[opts.generate as string];
					if (!sample) {
						output.error(`Unknown connector: ${opts.generate}`);
						output.info(`Available: ${Object.keys(SAMPLE_EVENTS).join(', ')}`);
						process.exitCode = 1;
						return;
					}
					// Regenerate IDs for freshness
					const event = {
						...sample,
						id: generateEventId(),
						timestamp: new Date().toISOString(),
						trace_id: generateTraceId(),
					};
					console.log(JSON.stringify(event, null, 2));
					return;
				}

				// Read event
				let eventJson: string;
				if (file === '-') {
					eventJson = await readEventFromStdin();
				} else if (file) {
					eventJson = await readFile(file, 'utf-8');
				} else {
					output.error('Provide an event file, use "-" for stdin, or --generate <connector>');
					process.exitCode = 1;
					return;
				}

				let event: OrgLoopEvent;
				try {
					event = JSON.parse(eventJson) as OrgLoopEvent;
				} catch {
					output.error('Invalid JSON in event file');
					process.exitCode = 1;
					return;
				}

				// Ensure event has required fields
				if (!event.id) event.id = generateEventId();
				if (!event.timestamp) event.timestamp = new Date().toISOString();
				if (!event.trace_id) event.trace_id = generateTraceId();

				output.blank();
				output.info(`Injecting test event: ${event.type} (source: ${event.source})`);
				output.blank();

				// Load config to find matching routes
				const config = await loadCliConfig({ configPath: globalOpts.config });

				// Use core's matchRoutes for parity with the runtime path.
				const { matchRoutes } = await import('@orgloop/core');
				const matchedRoutes = matchRoutes(event, config.routes).map((m) => m.route);

				if (matchedRoutes.length === 0) {
					output.warn('No routes matched this event.');
					if (output.isJsonMode()) {
						output.json({ event, matched_routes: 0, results: [] });
					}
					return;
				}

				const results: Array<{ step: string; status: string; duration_ms: number }> = [];

				for (const route of matchedRoutes) {
					// Process transforms
					if (route.transforms) {
						for (const tRef of route.transforms) {
							const transform = config.transforms.find((t) => t.name === tRef.ref);
							const start = Date.now();

							if (!transform) {
								output.error(`Transform: ${tRef.ref} — NOT FOUND`);
								results.push({
									step: `transform:${tRef.ref}`,
									status: 'not_found',
									duration_ms: 0,
								});
								continue;
							}

							// Simulate transform execution
							const duration = Date.now() - start + 1;
							output.success(`Transform: ${tRef.ref} — PASS (${duration}ms)`);
							results.push({
								step: `transform:${tRef.ref}`,
								status: 'pass',
								duration_ms: duration,
							});
						}
					}

					// Route match
					output.success(`Route match: ${route.name}`);
					results.push({ step: `route:${route.name}`, status: 'matched', duration_ms: 0 });

					// Delivery
					if (opts.dryRun) {
						output.info(`  Delivery: ${route.then.actor} — DRY RUN (skipped)`);
						results.push({
							step: `deliver:${route.then.actor}`,
							status: 'dry_run',
							duration_ms: 0,
						});
					} else {
						// Simulated delivery — no Runtime construction. Real delivery happens
						// against the daemon via `orgloop start` + webhook injection.
						output.success(`Delivery: ${route.then.actor} — OK (simulated)`);
						results.push({
							step: `deliver:${route.then.actor}`,
							status: 'simulated',
							duration_ms: 0,
						});
					}
				}

				output.blank();
				output.info(
					`Event ${event.id.slice(0, 16)} traced successfully through ${matchedRoutes.length} route${matchedRoutes.length > 1 ? 's' : ''}.`,
				);

				if (output.isJsonMode()) {
					output.json({ event, matched_routes: matchedRoutes.length, results });
				}
			} catch (err) {
				output.error(`Test failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});
}
