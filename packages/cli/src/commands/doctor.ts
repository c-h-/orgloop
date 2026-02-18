/**
 * orgloop doctor — Pre-flight environment validation.
 *
 * Runs validate internally (config, transforms, route graph), then adds
 * live checks: credential validation, service detection. Uses Stage 2
 * connector maturity (credential validators and service detectors) when
 * connectors provide them.
 *
 * Supports --json for machine-readable output.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CredentialValidator, OrgLoopConfig, ServiceDetector } from '@orgloop/sdk';
import chalk from 'chalk';
import type { Command } from 'commander';
import yaml from 'js-yaml';
import { loadCliConfig, resolveConfigPath } from '../config.js';
import { getEnvVarMeta } from '../env-metadata.js';
import * as output from '../output.js';
import { createProjectImport } from '../project-import.js';
import { type ImportFn, resolveConnectorRegistrations } from '../resolve-connectors.js';
import { scanEnvVars } from './env.js';
import { runValidation } from './validate.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DoctorCheck {
	category: 'credential' | 'config' | 'transform' | 'route-graph' | 'service' | 'dependency';
	name: string;
	status: 'ok' | 'missing' | 'error' | 'warning';
	detail?: string;
	description?: string;
	help_url?: string;
	/** Identity from credential validation (e.g., "user: @alice") */
	identity?: string;
	/** Scopes from credential validation (e.g., ["repo", "read:org"]) */
	scopes?: string[];
}

export interface DoctorResult {
	status: 'ok' | 'degraded' | 'error';
	project: string;
	checks: DoctorCheck[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadYaml(path: string): Promise<unknown> {
	const content = await readFile(path, 'utf-8');
	return yaml.load(content);
}

// ─── Check functions ─────────────────────────────────────────────────────────

/**
 * Run validate internally, converting its results to DoctorCheck format.
 * This is the static analysis phase — config, transforms, route graph.
 */
export async function checkValidation(configPath: string): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];

	try {
		const { results, graphWarnings } = await runValidation(configPath);

		// Convert validation results to doctor checks
		for (const result of results) {
			if (result.valid) {
				checks.push({
					category: 'config',
					name: result.file,
					status: 'ok',
					detail: result.description,
				});
			} else {
				checks.push({
					category: 'config',
					name: result.file,
					status: 'error',
					detail: result.errors.join('; '),
				});
			}
		}

		// Convert graph warnings to doctor checks
		for (const warning of graphWarnings) {
			checks.push({
				category: 'route-graph',
				name: warning.id,
				status: 'warning',
				detail: warning.message,
			});
		}
	} catch (err) {
		checks.push({
			category: 'config',
			name: 'orgloop.yaml',
			status: 'error',
			detail: `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
		});
	}

	return checks;
}

export async function checkCredentials(
	configPath: string,
	validators?: Map<string, CredentialValidator>,
): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];

	try {
		const vars = await scanEnvVars(configPath);

		for (const [name, _source] of vars) {
			const isSet = process.env[name] !== undefined;
			const meta = getEnvVarMeta(name);

			if (!isSet) {
				checks.push({
					category: 'credential',
					name,
					status: 'missing',
					...(meta?.description ? { description: meta.description } : {}),
					...(meta?.help_url ? { help_url: meta.help_url } : {}),
				});
				continue;
			}

			// If a credential validator exists for this env var, use it
			const validator = validators?.get(name);
			if (validator) {
				try {
					const envValue = process.env[name] ?? '';
					const result = await validator.validate(envValue);
					if (result.valid) {
						const detailParts: string[] = [];
						if (result.identity) detailParts.push(result.identity);
						if (result.scopes && result.scopes.length > 0) {
							detailParts.push(`scopes: ${result.scopes.join(', ')}`);
						}
						if (result.error) detailParts.push(result.error);

						checks.push({
							category: 'credential',
							name,
							status: 'ok',
							detail: detailParts.length > 0 ? `valid (${detailParts.join(', ')})` : 'valid',
							identity: result.identity,
							scopes: result.scopes,
						});
					} else {
						checks.push({
							category: 'credential',
							name,
							status: 'error',
							detail: result.error ?? 'Credential validation failed',
						});
					}
				} catch {
					// Validator threw — fail-open, treat as ok (presence check only)
					checks.push({ category: 'credential', name, status: 'ok' });
				}
			} else {
				// No validator available — fall back to presence check
				checks.push({ category: 'credential', name, status: 'ok' });
			}
		}
	} catch {
		// env var scanning is best-effort
	}

	return checks;
}

/**
 * Check service availability using service detectors from connector registrations.
 * Connector-agnostic: discovers detectors through the registration, never hardcodes
 * connector-specific logic.
 */
export async function checkServices(
	detectors: Map<string, ServiceDetector>,
): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];

	for (const [connectorId, detector] of detectors) {
		try {
			const result = await detector.detect();
			if (result.running) {
				const detail = result.endpoint ? `running at ${result.endpoint}` : 'running';
				checks.push({
					category: 'service',
					name: connectorId,
					status: 'ok',
					detail,
				});
			} else {
				const detail = result.endpoint ? `not reachable at ${result.endpoint}` : 'not running';
				checks.push({
					category: 'service',
					name: connectorId,
					status: 'warning',
					detail,
				});
			}
		} catch {
			// Detector threw — treat as warning (fail-open)
			checks.push({
				category: 'service',
				name: connectorId,
				status: 'warning',
				detail: 'Service detection failed',
			});
		}
	}

	return checks;
}

/**
 * Check that all @orgloop/* packages referenced in YAML configs exist in
 * the project's package.json dependencies or devDependencies.
 */
export async function checkDependencies(
	configPath: string,
	config?: OrgLoopConfig,
): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	const projectDir = dirname(configPath);

	// Read project package.json
	let deps: Set<string>;
	try {
		const pkgJsonPath = join(projectDir, 'package.json');
		const content = await readFile(pkgJsonPath, 'utf-8');
		const pkg = JSON.parse(content) as Record<string, unknown>;
		const allDeps = {
			...((pkg.dependencies ?? {}) as Record<string, string>),
			...((pkg.devDependencies ?? {}) as Record<string, string>),
		};
		deps = new Set(Object.keys(allDeps));
	} catch {
		// No package.json — can't validate
		return checks;
	}

	if (!config) return checks;

	// Collect all referenced packages
	const referenced = new Map<string, string>(); // package → where referenced
	for (const s of config.sources) {
		if (s.connector.startsWith('@')) referenced.set(s.connector, `source:${s.id}`);
	}
	for (const a of config.actors) {
		if (a.connector.startsWith('@')) referenced.set(a.connector, `actor:${a.id}`);
	}
	for (const t of config.transforms) {
		if (t.type === 'package' && t.package?.startsWith('@')) {
			referenced.set(t.package, `transform:${t.name}`);
		}
	}
	for (const l of config.loggers) {
		if (l.type.startsWith('@')) referenced.set(l.type, `logger:${l.name}`);
	}

	for (const [pkg, source] of referenced) {
		if (deps.has(pkg)) {
			checks.push({
				category: 'dependency',
				name: pkg,
				status: 'ok',
				detail: source,
			});
		} else {
			checks.push({
				category: 'dependency',
				name: pkg,
				status: 'error',
				detail: `Referenced by ${source} — run \`npm install ${pkg}\``,
			});
		}
	}

	return checks;
}

// ─── Main doctor logic ───────────────────────────────────────────────────────

export async function runDoctor(configPath: string, importFn?: ImportFn): Promise<DoctorResult> {
	const checks: DoctorCheck[] = [];

	// Determine project name
	let projectName = 'unknown';
	try {
		const data = (await loadYaml(configPath)) as Record<string, unknown>;
		const meta = data?.metadata as Record<string, unknown> | undefined;
		if (meta?.name) projectName = String(meta.name);
	} catch {
		// will be caught by checkValidation
	}

	// Default to project-relative import when no importFn provided
	const resolvedImportFn =
		importFn ?? (createProjectImport(dirname(configPath)) as unknown as ImportFn);

	// Resolve connector registrations to discover validators and detectors.
	// This is best-effort — if config loading fails (e.g., missing env vars),
	// we fall back to the basic presence-check behavior.
	let validators: Map<string, CredentialValidator> | undefined;
	let detectors: Map<string, ServiceDetector> | undefined;
	try {
		const config = await loadCliConfig({ configPath });
		const registrations = await resolveConnectorRegistrations(config, resolvedImportFn);

		// Collect all credential validators from all connector registrations
		const allValidators = new Map<string, CredentialValidator>();
		const allDetectors = new Map<string, ServiceDetector>();

		for (const [_pkg, reg] of registrations) {
			if (reg.credential_validators) {
				for (const [envVar, validator] of Object.entries(reg.credential_validators)) {
					allValidators.set(envVar, validator);
				}
			}
			if (reg.service_detector) {
				allDetectors.set(reg.id, reg.service_detector);
			}
		}

		if (allValidators.size > 0) validators = allValidators;
		if (allDetectors.size > 0) detectors = allDetectors;
	} catch {
		// Config loading failed (e.g., missing env vars) — proceed without validators
	}

	// Load config for dependency checks (best-effort, separate from connector loading)
	let loadedConfig: OrgLoopConfig | undefined;
	try {
		loadedConfig = await loadCliConfig({ configPath });
	} catch {
		// Config loading may fail (e.g., missing env vars)
	}

	// Phase 1: Static analysis (validate)
	// Phase 2: Live checks (credentials, services, dependencies)
	const [validationChecks, credentialChecks, serviceChecks, dependencyChecks] = await Promise.all([
		checkValidation(configPath),
		checkCredentials(configPath, validators),
		detectors ? checkServices(detectors) : Promise.resolve([]),
		checkDependencies(configPath, loadedConfig),
	]);

	checks.push(...dependencyChecks, ...credentialChecks, ...validationChecks, ...serviceChecks);

	// Determine overall status
	const hasError = checks.some((c) => c.status === 'error');
	const hasMissing = checks.some((c) => c.status === 'missing');
	const hasWarning = checks.some((c) => c.status === 'warning');

	let status: DoctorResult['status'] = 'ok';
	if (hasError) status = 'error';
	else if (hasMissing || hasWarning) status = 'degraded';

	return { status, project: projectName, checks };
}

// ─── Display ─────────────────────────────────────────────────────────────────

export function printDoctorResult(result: DoctorResult): void {
	output.blank();
	output.heading(`OrgLoop Doctor \u2014 ${result.project}`);

	// Group checks by category
	const byCategory = new Map<string, DoctorCheck[]>();
	for (const check of result.checks) {
		const existing = byCategory.get(check.category) ?? [];
		existing.push(check);
		byCategory.set(check.category, existing);
	}

	const categoryLabels: Record<string, string> = {
		dependency: 'Dependencies',
		credential: 'Credentials',
		config: 'Config',
		transform: 'Transforms',
		'route-graph': 'Route Graph',
		service: 'Services',
	};

	const categoryOrder = ['dependency', 'credential', 'service', 'config', 'route-graph'];

	for (const cat of categoryOrder) {
		const checks = byCategory.get(cat);
		if (!checks || checks.length === 0) continue;

		output.subheading(categoryLabels[cat] ?? cat);

		for (const check of checks) {
			if (check.status === 'ok') {
				const detail = check.detail ? ` \u2014 ${check.detail}` : '';
				console.log(`    ${chalk.green('\u2713')} ${check.name}${detail}`);
			} else if (check.status === 'missing') {
				console.log(`    ${chalk.red('\u2717')} ${check.name} \u2014 not set`);
				if (check.description) {
					console.log(`      ${chalk.dim('\u2192')} ${chalk.dim(check.description)}`);
				}
				if (check.help_url) {
					console.log(`      ${chalk.dim('\u2192')} ${chalk.dim(check.help_url)}`);
				}
			} else if (check.status === 'error') {
				const detail = check.detail ? ` \u2014 ${check.detail}` : '';
				console.log(`    ${chalk.red('\u2717')} ${check.name}${detail}`);
			} else if (check.status === 'warning') {
				const detail = check.detail ? ` \u2014 ${check.detail}` : '';
				console.log(`    ${chalk.yellow('!')} ${check.name}${detail}`);
			}
		}
	}

	// Summary
	output.blank();
	const errorCount = result.checks.filter((c) => c.status === 'error').length;
	const missingCount = result.checks.filter((c) => c.status === 'missing').length;
	const warningCount = result.checks.filter((c) => c.status === 'warning').length;

	const parts: string[] = [];
	if (errorCount > 0) parts.push(`${errorCount} error${errorCount !== 1 ? 's' : ''}`);
	if (missingCount > 0)
		parts.push(`${missingCount} credential${missingCount !== 1 ? 's' : ''} missing`);
	if (warningCount > 0) parts.push(`${warningCount} warning${warningCount !== 1 ? 's' : ''}`);

	if (parts.length === 0) {
		output.info(chalk.green('All checks passed.'));
		output.info(chalk.dim('Next: run `orgloop start` to start.'));
	} else {
		output.info(`${parts.join(', ')}.`);
		if (result.status === 'degraded') {
			output.info(chalk.dim('System will run in degraded mode.'));
		} else if (result.status === 'error') {
			output.info(chalk.dim('Fix errors above, then re-run `orgloop doctor`.'));
		}
	}
}

// ─── Command registration ────────────────────────────────────────────────────

export function registerDoctorCommand(program: Command): void {
	program
		.command('doctor')
		.description('Pre-flight environment validation')
		.action(async (_opts, cmd) => {
			try {
				const globalOpts = cmd.parent?.opts() ?? {};
				const configPath = resolveConfigPath(globalOpts.config);

				const result = await runDoctor(configPath);

				if (output.isJsonMode()) {
					output.json(result);
					if (result.status === 'error') process.exitCode = 2;
					else if (result.status === 'degraded') process.exitCode = 1;
					return;
				}

				printDoctorResult(result);

				if (result.status === 'error') process.exitCode = 2;
				else if (result.status === 'degraded') process.exitCode = 1;
			} catch (err) {
				output.error(`Doctor failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});
}
