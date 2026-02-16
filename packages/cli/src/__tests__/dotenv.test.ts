import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDotEnv } from '../dotenv.js';

describe('loadDotEnv', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'orgloop-dotenv-test-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('loads KEY=VALUE pairs from .env next to orgloop.yaml', async () => {
		await writeFile(
			join(tempDir, 'orgloop.yaml'),
			'apiVersion: orgloop/v1alpha1\nkind: Project\nmetadata:\n  name: test\n',
		);
		await writeFile(join(tempDir, '.env'), 'DOTENV_TEST_A=hello\nDOTENV_TEST_B=world\n');

		// Ensure vars are not set
		delete process.env.DOTENV_TEST_A;
		delete process.env.DOTENV_TEST_B;

		try {
			const loaded = await loadDotEnv(join(tempDir, 'orgloop.yaml'));
			expect(loaded).toContain('DOTENV_TEST_A');
			expect(loaded).toContain('DOTENV_TEST_B');
			expect(process.env.DOTENV_TEST_A).toBe('hello');
			expect(process.env.DOTENV_TEST_B).toBe('world');
		} finally {
			delete process.env.DOTENV_TEST_A;
			delete process.env.DOTENV_TEST_B;
		}
	});

	it('skips comments and blank lines', async () => {
		await writeFile(
			join(tempDir, 'orgloop.yaml'),
			'apiVersion: orgloop/v1alpha1\nkind: Project\nmetadata:\n  name: test\n',
		);
		await writeFile(
			join(tempDir, '.env'),
			'# This is a comment\n\nDOTENV_TEST_COMMENT=yes\n  # indented comment\n',
		);

		delete process.env.DOTENV_TEST_COMMENT;

		try {
			const loaded = await loadDotEnv(join(tempDir, 'orgloop.yaml'));
			expect(loaded).toEqual(['DOTENV_TEST_COMMENT']);
			expect(process.env.DOTENV_TEST_COMMENT).toBe('yes');
		} finally {
			delete process.env.DOTENV_TEST_COMMENT;
		}
	});

	it('handles quoted values', async () => {
		await writeFile(
			join(tempDir, 'orgloop.yaml'),
			'apiVersion: orgloop/v1alpha1\nkind: Project\nmetadata:\n  name: test\n',
		);
		await writeFile(
			join(tempDir, '.env'),
			'DOTENV_TEST_DQ="double quoted"\nDOTENV_TEST_SQ=\'single quoted\'\n',
		);

		delete process.env.DOTENV_TEST_DQ;
		delete process.env.DOTENV_TEST_SQ;

		try {
			const loaded = await loadDotEnv(join(tempDir, 'orgloop.yaml'));
			expect(loaded).toContain('DOTENV_TEST_DQ');
			expect(loaded).toContain('DOTENV_TEST_SQ');
			expect(process.env.DOTENV_TEST_DQ).toBe('double quoted');
			expect(process.env.DOTENV_TEST_SQ).toBe('single quoted');
		} finally {
			delete process.env.DOTENV_TEST_DQ;
			delete process.env.DOTENV_TEST_SQ;
		}
	});

	it('shell env takes precedence over .env', async () => {
		await writeFile(
			join(tempDir, 'orgloop.yaml'),
			'apiVersion: orgloop/v1alpha1\nkind: Project\nmetadata:\n  name: test\n',
		);
		await writeFile(join(tempDir, '.env'), 'DOTENV_TEST_EXISTING=from-dotenv\n');

		process.env.DOTENV_TEST_EXISTING = 'from-shell';

		try {
			const loaded = await loadDotEnv(join(tempDir, 'orgloop.yaml'));
			expect(loaded).not.toContain('DOTENV_TEST_EXISTING');
			expect(process.env.DOTENV_TEST_EXISTING).toBe('from-shell');
		} finally {
			delete process.env.DOTENV_TEST_EXISTING;
		}
	});

	it('silently skips when no .env file exists', async () => {
		await writeFile(
			join(tempDir, 'orgloop.yaml'),
			'apiVersion: orgloop/v1alpha1\nkind: Project\nmetadata:\n  name: test\n',
		);

		const loaded = await loadDotEnv(join(tempDir, 'orgloop.yaml'));
		expect(loaded).toEqual([]);
	});

	it('returns only newly loaded vars (not ones already in env)', async () => {
		await writeFile(
			join(tempDir, 'orgloop.yaml'),
			'apiVersion: orgloop/v1alpha1\nkind: Project\nmetadata:\n  name: test\n',
		);
		await writeFile(
			join(tempDir, '.env'),
			'DOTENV_TEST_NEW=new-value\nDOTENV_TEST_OLD=old-value\n',
		);

		delete process.env.DOTENV_TEST_NEW;
		process.env.DOTENV_TEST_OLD = 'already-set';

		try {
			const loaded = await loadDotEnv(join(tempDir, 'orgloop.yaml'));
			expect(loaded).toEqual(['DOTENV_TEST_NEW']);
			expect(process.env.DOTENV_TEST_NEW).toBe('new-value');
			expect(process.env.DOTENV_TEST_OLD).toBe('already-set');
		} finally {
			delete process.env.DOTENV_TEST_NEW;
			delete process.env.DOTENV_TEST_OLD;
		}
	});
});
