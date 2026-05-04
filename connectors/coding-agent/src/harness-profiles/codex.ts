import type { HarnessProfile } from './index.js';
import { buildLifecycleEvent, type SessionPayload } from './shared.js';

export const CODEX_PROFILE: HarnessProfile = {
	name: 'codex',
	signatureHeader: 'x-hub-signature-256',
	hmacAlgorithm: 'sha256',
	normalizePayload: (raw, { sourceId, platformOverride }) => {
		const payload = raw as SessionPayload & { model?: string };
		return buildLifecycleEvent({
			platform: platformOverride ?? 'codex',
			harness: 'codex',
			sourceId,
			payload,
			extraPayload: payload.model ? { model: payload.model } : undefined,
		});
	},
};
