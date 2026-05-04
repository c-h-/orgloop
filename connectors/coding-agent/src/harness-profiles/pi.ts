import type { HarnessProfile } from './index.js';
import { buildLifecycleEvent, type SessionPayload } from './shared.js';

export const PI_PROFILE: HarnessProfile = {
	name: 'pi',
	signatureHeader: 'x-hub-signature-256',
	hmacAlgorithm: 'sha256',
	normalizePayload: (raw, { sourceId, platformOverride }) =>
		buildLifecycleEvent({
			platform: platformOverride ?? 'pi',
			harness: 'pi',
			sourceId,
			payload: raw as SessionPayload,
		}),
};
