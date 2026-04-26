import type { HarnessProfile } from './index.js';
import { buildLifecycleEvent, type SessionPayload } from './shared.js';

export const OPENCODE_PROFILE: HarnessProfile = {
	name: 'opencode',
	signatureHeader: 'x-hub-signature-256',
	hmacAlgorithm: 'sha256',
	normalizePayload: (raw, { sourceId, platformOverride }) => {
		// OpenCode webhook payloads carry an optional `model` field that
		// downstream actors expect to receive verbatim.
		const payload = raw as SessionPayload & { model?: string };
		return buildLifecycleEvent({
			platform: platformOverride ?? 'opencode',
			harness: 'opencode',
			sourceId,
			payload,
			extraPayload: payload.model ? { model: payload.model } : undefined,
		});
	},
};
