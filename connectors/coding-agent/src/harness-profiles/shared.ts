/**
 * Shared lifecycle normalization for coding-agent harness profiles.
 * Each harness uses the same payload shape; only the platform/harness
 * identifier strings differ.
 */

import type { LifecycleOutcome, LifecyclePhase, OrgLoopEvent } from '@orgloop/sdk';
import { buildDedupeKey, buildEvent, eventTypeForPhase, TERMINAL_PHASES } from '@orgloop/sdk';

export interface SessionPayload {
	session_id: string;
	working_directory?: string;
	cwd?: string;
	duration_seconds?: number;
	exit_status?: number;
	summary?: string;
	transcript_path?: string;
	timestamp?: string;
	hook_type?: 'start' | 'stop';
	model?: string;
	meta?: Record<string, unknown>;
}

const SIGNAL_NAMES: Record<number, string> = {
	2: 'sigint',
	9: 'sigkill',
	15: 'sigterm',
};

export function resolveLifecycle(payload: SessionPayload): {
	phase: LifecyclePhase;
	outcome?: LifecycleOutcome;
	reason?: string;
} {
	const hookType = payload.hook_type ?? 'stop';
	if (hookType === 'start') return { phase: 'started' };

	const exitStatus = payload.exit_status ?? 0;
	if (exitStatus === 0) {
		return { phase: 'completed', outcome: 'success', reason: 'exit_code_0' };
	}
	if (exitStatus > 128) {
		const signal = exitStatus - 128;
		const signalName = SIGNAL_NAMES[signal] ?? `signal_${signal}`;
		return { phase: 'stopped', outcome: 'cancelled', reason: signalName };
	}
	return { phase: 'failed', outcome: 'failure', reason: `exit_code_${exitStatus}` };
}

/**
 * Build a normalized lifecycle event for a session payload. All coding-agent
 * harness profiles share this normalization — only the platform identifier
 * (and any extra payload fields) differ.
 */
export function buildLifecycleEvent(opts: {
	platform: string;
	harness: string;
	sourceId: string;
	payload: SessionPayload;
	extraPayload?: Record<string, unknown>;
}): OrgLoopEvent {
	const { platform, harness, sourceId, payload } = opts;
	const workingDirectory = payload.working_directory ?? payload.cwd ?? '';
	const sessionId = payload.session_id;
	const now = new Date().toISOString();

	const { phase, outcome, reason } = resolveLifecycle(payload);
	const terminal = TERMINAL_PHASES.has(phase);

	return buildEvent({
		source: sourceId,
		type: eventTypeForPhase(phase),
		provenance: {
			platform,
			platform_event: `session.${phase}`,
			author: platform,
			author_type: 'bot',
			session_id: sessionId,
			working_directory: workingDirectory,
		},
		payload: {
			lifecycle: {
				phase,
				terminal,
				...(terminal && outcome ? { outcome } : {}),
				...(reason ? { reason } : {}),
				dedupe_key: buildDedupeKey(platform, sessionId, phase),
			},
			session: {
				id: sessionId,
				adapter: platform,
				harness,
				cwd: workingDirectory || undefined,
				started_at: terminal ? undefined : now,
				...(terminal
					? {
							ended_at: now,
							exit_status: payload.exit_status ?? 0,
						}
					: {}),
				...(payload.meta ? { meta: payload.meta } : {}),
			},
			session_id: sessionId,
			working_directory: workingDirectory,
			cwd: workingDirectory,
			duration_seconds: payload.duration_seconds ?? 0,
			exit_status: payload.exit_status ?? 0,
			summary: payload.summary ?? '',
			transcript_path: payload.transcript_path ?? '',
			...(payload.meta ? { meta: payload.meta } : {}),
			...(opts.extraPayload ?? {}),
		},
	});
}
