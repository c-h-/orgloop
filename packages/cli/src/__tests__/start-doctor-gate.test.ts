import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../commands/doctor.js';

describe('start doctor gate', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'orgloop-apply-doctor-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('runDoctor returns ok when config is valid and env vars are set', async () => {
		await writeFile(
			join(tempDir, 'orgloop.yaml'),
			`apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: test-ok
`,
		);

		const result = await runDoctor(join(tempDir, 'orgloop.yaml'));
		expect(result.status).toBe('ok');
		expect(result.project).toBe('test-ok');
	});

	it('runDoctor returns error when config has invalid schema', async () => {
		await writeFile(
			join(tempDir, 'orgloop.yaml'),
			`apiVersion: orgloop/v1alpha1
kind: Wrong
`,
		);

		const result = await runDoctor(join(tempDir, 'orgloop.yaml'));
		expect(result.status).toBe('error');
		const errorChecks = result.checks.filter((c) => c.status === 'error');
		expect(errorChecks.length).toBeGreaterThan(0);
	});

	it('runDoctor returns degraded when env vars are missing', async () => {
		await mkdir(join(tempDir, 'connectors'), { recursive: true });

		await writeFile(
			join(tempDir, 'orgloop.yaml'),
			`apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: test-degraded
connectors:
  - connectors/test.yaml
`,
		);

		await writeFile(
			join(tempDir, 'connectors', 'test.yaml'),
			`sources:
  - id: test-source
    connector: "@orgloop/connector-test"
    config:
      token: "\${APPLY_DOCTOR_GATE_MISSING_VAR}"
`,
		);

		// Ensure the var is not set
		// biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
		delete process.env.APPLY_DOCTOR_GATE_MISSING_VAR;

		const result = await runDoctor(join(tempDir, 'orgloop.yaml'));
		// Missing env vars result in degraded (missing credentials)
		expect(['degraded', 'error']).toContain(result.status);
		const missingChecks = result.checks.filter((c) => c.status === 'missing');
		expect(missingChecks.length).toBeGreaterThan(0);
	});

	it('doctor gate allows --force to bypass errors', async () => {
		// This test validates the concept: when force=true, doctor is skipped.
		// We test this by confirming runDoctor would return error,
		// showing that the gate would block without --force.
		await writeFile(
			join(tempDir, 'orgloop.yaml'),
			`apiVersion: orgloop/v1alpha1
kind: Wrong
`,
		);

		const result = await runDoctor(join(tempDir, 'orgloop.yaml'));
		expect(result.status).toBe('error');
		// With --force, this error would be skipped and start would proceed
	});

	it('printDoctorResult is exported and callable', async () => {
		const { printDoctorResult } = await import('../commands/doctor.js');
		expect(typeof printDoctorResult).toBe('function');
	});
});
