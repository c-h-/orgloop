/**
 * Transform pipeline executor.
 *
 * Executes transforms in sequence for a route. Supports both script
 * transforms (shell scripts via child_process) and package transforms.
 *
 * Script transform contract:
 * - stdin = JSON event
 * - stdout = modified JSON event (or empty = drop)
 * - exit 0 = success, exit 1 = drop, exit >= 2 = error (fail-open)
 */

import { execFile } from 'node:child_process';
import type {
	LogEntry,
	OrgLoopEvent,
	RouteTransformRef,
	TransformDefinition,
	TransformErrorPolicy,
} from '@orgloop/sdk';
import type { Transform, TransformContext } from '@orgloop/sdk';
import { TransformError } from './errors.js';

// ─── Script Transform Execution ──────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;

interface ScriptResult {
	event: OrgLoopEvent | null;
	dropped: boolean;
	error?: Error;
}

function runScript(
	scriptPath: string,
	event: OrgLoopEvent,
	context: TransformContext,
	timeoutMs: number,
): Promise<ScriptResult> {
	return new Promise((resolve) => {
		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			ORGLOOP_SOURCE: context.source,
			ORGLOOP_TARGET: context.target,
			ORGLOOP_EVENT_TYPE: context.eventType,
			ORGLOOP_EVENT_ID: event.id,
			ORGLOOP_ROUTE: context.routeName,
		};

		const child = execFile(
			scriptPath,
			[],
			{ timeout: timeoutMs, env, maxBuffer: 10 * 1024 * 1024 },
			(error, stdout, _stderr) => {
				if (error) {
					// execFile errors have a `code` property that is the exit code (number)
					// or a Node error code (string) for system errors
					const errWithCode = error as Error & { code?: string | number };
					const exitCode = typeof errWithCode.code === 'number' ? errWithCode.code : null;
					// exit 1 = intentional drop
					if (exitCode === 1) {
						resolve({ event: null, dropped: true });
						return;
					}
					// exit >= 2 or other errors = fail-open (pass through original)
					resolve({ event, dropped: false, error: error as Error });
					return;
				}

				const trimmed = stdout.trim();
				if (!trimmed) {
					// Empty stdout = drop
					resolve({ event: null, dropped: true });
					return;
				}

				try {
					const modified = JSON.parse(trimmed) as OrgLoopEvent;
					resolve({ event: modified, dropped: false });
				} catch (parseErr) {
					// Invalid JSON = fail-open
					resolve({ event, dropped: false, error: parseErr as Error });
				}
			},
		);

		// Write event JSON to stdin
		if (child.stdin) {
			child.stdin.write(JSON.stringify(event));
			child.stdin.end();
		}
	});
}

// ─── Pipeline Executor ───────────────────────────────────────────────────────

export interface TransformPipelineOptions {
	/** All registered transform definitions */
	definitions: TransformDefinition[];
	/** Loaded package transform instances (keyed by name) */
	packageTransforms: Map<string, Transform>;
	/** Log callback for pipeline observability */
	onLog?: (entry: Partial<LogEntry>) => void;
}

export interface TransformPipelineResult {
	event: OrgLoopEvent | null;
	dropped: boolean;
	dropTransform?: string;
	error?: Error;
}

/**
 * Apply the on_error policy when a transform fails.
 * Returns a pipeline result to short-circuit the pipeline, or undefined to continue.
 */
function applyErrorPolicy(
	policy: TransformErrorPolicy,
	transformName: string,
	error: Error,
	event: OrgLoopEvent,
	durationMs: number,
	options: TransformPipelineOptions,
): TransformPipelineResult | undefined {
	if (policy === 'drop') {
		options.onLog?.({
			phase: 'transform.error_drop',
			transform: transformName,
			event_id: event.id,
			trace_id: event.trace_id,
			error: error.message,
			duration_ms: durationMs,
		});
		return { event: null, dropped: true, dropTransform: transformName, error };
	}

	if (policy === 'halt') {
		options.onLog?.({
			phase: 'transform.error_halt',
			transform: transformName,
			event_id: event.id,
			trace_id: event.trace_id,
			error: error.message,
			duration_ms: durationMs,
		});
		throw new TransformError(
			transformName,
			`Transform "${transformName}" failed with halt policy: ${error.message}`,
		);
	}

	// policy === 'pass' (default): fail-open, continue with current event
	options.onLog?.({
		phase: 'transform.error',
		transform: transformName,
		event_id: event.id,
		trace_id: event.trace_id,
		error: error.message,
		duration_ms: durationMs,
	});
	return undefined;
}

/**
 * Execute a transform pipeline for a route.
 */
export async function executeTransformPipeline(
	event: OrgLoopEvent,
	context: TransformContext,
	transformRefs: RouteTransformRef[],
	options: TransformPipelineOptions,
): Promise<TransformPipelineResult> {
	let current: OrgLoopEvent = event;

	for (const ref of transformRefs) {
		const def = options.definitions.find((d) => d.name === ref.ref);
		if (!def) {
			throw new TransformError(ref.ref, `Transform "${ref.ref}" not found in definitions`);
		}

		const startTime = Date.now();

		options.onLog?.({
			phase: 'transform.start',
			transform: def.name,
			event_id: current.id,
			trace_id: current.trace_id,
		});

		const policy: TransformErrorPolicy = ref.on_error ?? def.on_error ?? 'pass';

		if (def.type === 'script' && def.script) {
			const result = await runScript(
				def.script,
				current,
				context,
				def.timeout_ms ?? DEFAULT_TIMEOUT_MS,
			);

			const durationMs = Date.now() - startTime;

			if (result.dropped) {
				options.onLog?.({
					phase: 'transform.drop',
					transform: def.name,
					event_id: current.id,
					trace_id: current.trace_id,
					duration_ms: durationMs,
				});
				return { event: null, dropped: true, dropTransform: def.name };
			}

			if (result.error) {
				const errorResult = applyErrorPolicy(
					policy,
					def.name,
					result.error,
					current,
					durationMs,
					options,
				);
				if (errorResult) return errorResult;
			}

			if (result.event) {
				current = result.event;
			}

			options.onLog?.({
				phase: 'transform.pass',
				transform: def.name,
				event_id: current.id,
				trace_id: current.trace_id,
				duration_ms: durationMs,
			});
		} else if (def.type === 'package') {
			const transform = options.packageTransforms.get(def.name);
			if (!transform) {
				throw new TransformError(def.name, `Package transform "${def.name}" not loaded`);
			}

			try {
				const result = await transform.execute(current, context);
				const durationMs = Date.now() - startTime;

				if (result === null) {
					options.onLog?.({
						phase: 'transform.drop',
						transform: def.name,
						event_id: current.id,
						trace_id: current.trace_id,
						duration_ms: durationMs,
					});
					return { event: null, dropped: true, dropTransform: def.name };
				}

				current = result;
				options.onLog?.({
					phase: 'transform.pass',
					transform: def.name,
					event_id: current.id,
					trace_id: current.trace_id,
					duration_ms: durationMs,
				});
			} catch (err) {
				const durationMs = Date.now() - startTime;
				const errorResult = applyErrorPolicy(
					policy,
					def.name,
					err as Error,
					current,
					durationMs,
					options,
				);
				if (errorResult) return errorResult;
			}
		}
	}

	return { event: current, dropped: false };
}
