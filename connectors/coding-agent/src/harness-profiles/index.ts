/**
 * HarnessProfile — runtime behavior overlay applied to the generic
 * coding-agent webhook receiver.
 *
 * Profiles let one connector handle multiple coding-agent harnesses
 * (Claude Code, Codex, OpenCode, Pi, Pi-rust) by encoding the
 * per-harness signature header, HMAC algorithm, and payload normalizer
 * (lifecycle resolution is shared via shared.ts.resolveLifecycle) in data.
 *
 * Each profile is loaded by id (string) at init() time. Setup metadata
 * (env-var names, integrations) lives outside this module — it is in the
 * CLI's PLUGIN_CATALOG, joined to the profile by the harness `name`.
 */

import type { OrgLoopEvent } from '@orgloop/sdk';
import { CLAUDE_CODE_PROFILE } from './claude-code.js';
import { CODEX_PROFILE } from './codex.js';
import { OPENCODE_PROFILE } from './opencode.js';
import { PI_PROFILE } from './pi.js';
import { PI_RUST_PROFILE } from './pi-rust.js';

export type HarnessName = 'claude-code' | 'codex' | 'opencode' | 'pi' | 'pi-rust';

export interface NormalizeContext {
	sourceId: string;
	/** Optional explicit platform override from the source config. */
	platformOverride?: string;
}

export interface HarnessProfile {
	name: HarnessName;
	/** HTTP header that carries the HMAC signature for this harness. */
	signatureHeader: string;
	/** HMAC algorithm (currently always 'sha256'). */
	hmacAlgorithm: 'sha256' | string;
	/**
	 * Normalize a raw webhook payload into an OrgLoopEvent. The connector
	 * passes the parsed body and the routing context; the profile decides how
	 * to shape the event. `platformOverride`, when provided, replaces the
	 * profile's default platform identifier in provenance and dedupe keys.
	 */
	normalizePayload: (raw: unknown, ctx: NormalizeContext) => OrgLoopEvent;
}

export const HARNESS_PROFILES: Record<HarnessName, HarnessProfile> = {
	'claude-code': CLAUDE_CODE_PROFILE,
	codex: CODEX_PROFILE,
	opencode: OPENCODE_PROFILE,
	pi: PI_PROFILE,
	'pi-rust': PI_RUST_PROFILE,
};

export function getHarnessProfile(name: string): HarnessProfile {
	const profile = HARNESS_PROFILES[name as HarnessName];
	if (!profile) {
		const valid = Object.keys(HARNESS_PROFILES).join(', ');
		throw new Error(`Unknown coding-agent harness "${name}". Valid harnesses: ${valid}`);
	}
	return profile;
}
