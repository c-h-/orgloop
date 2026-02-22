/**
 * GitHub credential validator — probes the GitHub API to verify a token works.
 *
 * Stage 2 connector maturity: validates that GITHUB_TOKEN actually authenticates
 * and reports the associated user identity and OAuth scopes.
 */

import type { CredentialValidator } from '@orgloop/sdk';

export class GitHubCredentialValidator implements CredentialValidator {
	/**
	 * Fallback probe for GitHub App installation tokens.
	 * Calls GET /installation/repositories?per_page=1 which works for app tokens.
	 */
	private async probeAppToken(
		headers: Record<string, string>,
	): Promise<{ valid: boolean; identity?: string; scopes?: string[]; error?: string }> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);

		const response = await fetch('https://api.github.com/installation/repositories?per_page=1', {
			headers,
			signal: controller.signal,
		});

		clearTimeout(timeout);

		if (!response.ok) {
			return {
				valid: false,
				error: `GitHub API returned 403 for /user and ${response.status} for /installation/repositories`,
			};
		}

		return {
			valid: true,
			identity: 'app: GitHub App installation',
		};
	}

	async validate(
		value: string,
	): Promise<{ valid: boolean; identity?: string; scopes?: string[]; error?: string }> {
		try {
			const headers = {
				Authorization: `Bearer ${value}`,
				Accept: 'application/vnd.github+json',
				'User-Agent': 'orgloop-doctor',
			};

			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5000);

			const response = await fetch('https://api.github.com/user', {
				headers,
				signal: controller.signal,
			});

			clearTimeout(timeout);

			if (response.status === 401) {
				return { valid: false, error: 'Invalid token (401 Unauthorized)' };
			}

			// GitHub App installation tokens (ghs_*) get 403 on /user since they
			// have no user identity. Probe /installation/repositories instead.
			if (response.status === 403) {
				return this.probeAppToken(headers);
			}

			if (!response.ok) {
				return {
					valid: false,
					error: `GitHub API returned ${response.status} ${response.statusText}`,
				};
			}

			const data = (await response.json()) as { login?: string };
			const scopeHeader = response.headers.get('x-oauth-scopes');
			const scopes = scopeHeader
				? scopeHeader
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean)
				: undefined;

			return {
				valid: true,
				identity: data.login ? `user: @${data.login}` : undefined,
				scopes,
			};
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') {
				return { valid: true, error: 'Validation timed out (GitHub may be unreachable)' };
			}
			// Fail-open: network errors treated as "ok with a note"
			return {
				valid: true,
				error: `Could not reach GitHub API: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}
}
