import type { HarnessProfile } from './index.js';
import { buildLifecycleEvent, type SessionPayload } from './shared.js';

export const PI_RUST_PROFILE: HarnessProfile = {
	name: 'pi-rust',
	signatureHeader: 'x-hub-signature-256',
	hmacAlgorithm: 'sha256',
	normalizePayload: (raw, { sourceId, platformOverride }) =>
		buildLifecycleEvent({
			platform: platformOverride ?? 'pi-rust',
			harness: 'pi-rust',
			sourceId,
			payload: raw as SessionPayload,
		}),
};
