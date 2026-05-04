import type { HarnessProfile } from './index.js';
import { buildLifecycleEvent, type SessionPayload } from './shared.js';

export const CLAUDE_CODE_PROFILE: HarnessProfile = {
	name: 'claude-code',
	signatureHeader: 'x-hub-signature-256',
	hmacAlgorithm: 'sha256',
	normalizePayload: (raw, { sourceId, platformOverride }) =>
		buildLifecycleEvent({
			platform: platformOverride ?? 'claude-code',
			harness: 'claude-code',
			sourceId,
			payload: raw as SessionPayload,
		}),
};
