import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubCredentialValidator } from '../validator.js';

describe('GitHubCredentialValidator', () => {
	let validator: GitHubCredentialValidator;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		validator = new GitHubCredentialValidator();
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns valid with identity and scopes on success', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ login: 'alice' }),
			headers: new Headers({ 'x-oauth-scopes': 'repo, read:org' }),
		});

		const result = await validator.validate('ghp_testtoken');

		expect(result.valid).toBe(true);
		expect(result.identity).toBe('user: @alice');
		expect(result.scopes).toEqual(['repo', 'read:org']);
		expect(fetchMock).toHaveBeenCalledWith(
			'https://api.github.com/user',
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: 'Bearer ghp_testtoken',
				}),
			}),
		);
	});

	it('returns invalid on 401', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 401,
			statusText: 'Unauthorized',
		});

		const result = await validator.validate('bad-token');

		expect(result.valid).toBe(false);
		expect(result.error).toContain('401');
	});

	it('returns invalid on non-ok non-401 response', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 500,
			statusText: 'Internal Server Error',
		});

		const result = await validator.validate('some-token');

		expect(result.valid).toBe(false);
		expect(result.error).toContain('500');
	});

	it('validates GitHub App installation token via fallback probe on 403', async () => {
		// /user returns 403 for app installation tokens
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 403,
			statusText: 'Forbidden',
		});
		// Fallback: /installation/repositories succeeds
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ repositories: [] }),
			headers: new Headers({}),
		});

		const result = await validator.validate('ghs_apptoken123');

		expect(result.valid).toBe(true);
		expect(result.identity).toBe('app: GitHub App installation');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://api.github.com/user', expect.anything());
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			'https://api.github.com/installation/repositories?per_page=1',
			expect.anything(),
		);
	});

	it('returns invalid when 403 on /user and fallback also fails', async () => {
		// /user returns 403
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 403,
			statusText: 'Forbidden',
		});
		// Fallback also fails (e.g. truly forbidden token)
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 401,
			statusText: 'Unauthorized',
		});

		const result = await validator.validate('ghs_badtoken');

		expect(result.valid).toBe(false);
		expect(result.error).toContain('403');
		expect(result.error).toContain('401');
	});

	it('fails open on network error', async () => {
		fetchMock.mockRejectedValueOnce(new Error('fetch failed'));

		const result = await validator.validate('any-token');

		expect(result.valid).toBe(true);
		expect(result.error).toContain('Could not reach GitHub API');
	});

	it('fails open on timeout', async () => {
		const abortError = new DOMException('The operation was aborted', 'AbortError');
		fetchMock.mockRejectedValueOnce(abortError);

		const result = await validator.validate('any-token');

		expect(result.valid).toBe(true);
		expect(result.error).toContain('timed out');
	});

	it('handles missing scopes header', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ login: 'alice' }),
			headers: new Headers({}),
		});

		const result = await validator.validate('fine-grained-token');

		expect(result.valid).toBe(true);
		expect(result.identity).toBe('user: @alice');
		expect(result.scopes).toBeUndefined();
	});
});
