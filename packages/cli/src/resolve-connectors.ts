/**
 * Connector instantiation bridge.
 *
 * Dynamically imports connector packages referenced in config,
 * instantiates source/actor connectors, and returns Maps keyed by ID.
 *
 * Packages are resolved from the project directory's node_modules,
 * not the CLI's install location.
 */

import { connectorKey, loggerKey, transformKey } from '@orgloop/core';
import type {
	ActorConnector,
	ConnectorRegistration,
	LoggerRegistration,
	OrgLoopConfig,
	SourceConnector,
	TransformRegistration,
} from '@orgloop/sdk';
import { createProjectImport } from './project-import.js';

export interface ResolvedConnectors {
	sources: Map<string, SourceConnector>;
	actors: Map<string, ActorConnector>;
}

export type ImportFn = (specifier: string) => Promise<{ default: () => ConnectorRegistration }>;

/**
 * Resolve all connectors referenced in config by dynamically importing
 * their packages and instantiating source/actor instances.
 */
export async function resolveConnectors(
	config: OrgLoopConfig,
	importFn: ImportFn,
): Promise<ResolvedConnectors> {
	const sources = new Map<string, SourceConnector>();
	const actors = new Map<string, ActorConnector>();

	// Collect unique connector package names
	const packageMap = new Map<string, ConnectorRegistration>();

	const allPackages = new Set<string>();
	for (const s of config.sources) {
		allPackages.add(s.connector);
	}
	for (const a of config.actors) {
		allPackages.add(a.connector);
	}

	// Import each unique connector package
	for (const packageName of allPackages) {
		if (packageMap.has(packageName)) continue;

		let mod: { default: () => ConnectorRegistration };
		try {
			mod = await importFn(packageName);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Failed to import connector "${packageName}": ${msg}\n` +
					`  Hint: run \`npm install ${packageName}\` in your project directory.`,
			);
		}

		if (typeof mod.default !== 'function') {
			throw new Error(
				`Connector "${packageName}" does not export a default registration function.`,
			);
		}

		const registration = mod.default();
		packageMap.set(packageName, registration);
	}

	// Instantiate sources
	for (const sourceCfg of config.sources) {
		const reg = packageMap.get(sourceCfg.connector);
		if (!reg) continue;

		if (!reg.source) {
			throw new Error(
				`Connector "${sourceCfg.connector}" does not provide a source, ` +
					`but source "${sourceCfg.id}" requires one.`,
			);
		}

		sources.set(sourceCfg.id, new reg.source());
	}

	// Instantiate actors
	for (const actorCfg of config.actors) {
		const reg = packageMap.get(actorCfg.connector);
		if (!reg) continue;

		if (!reg.target) {
			throw new Error(
				`Connector "${actorCfg.connector}" does not provide a target, ` +
					`but actor "${actorCfg.id}" requires one.`,
			);
		}

		actors.set(actorCfg.id, new reg.target());
	}

	return { sources, actors };
}

/**
 * Resolve connector registrations (without instantiating sources/actors).
 *
 * Used by doctor to discover credential_validators and service_detectors
 * without needing a full engine startup. Returns a Map of package name -> registration.
 */
export async function resolveConnectorRegistrations(
	config: OrgLoopConfig,
	importFn: ImportFn,
): Promise<Map<string, ConnectorRegistration>> {
	const registrations = new Map<string, ConnectorRegistration>();

	const allPackages = new Set<string>();
	for (const s of config.sources) {
		allPackages.add(s.connector);
	}
	for (const a of config.actors) {
		allPackages.add(a.connector);
	}

	for (const packageName of allPackages) {
		try {
			const mod = await importFn(packageName);
			if (typeof mod.default === 'function') {
				registrations.set(packageName, mod.default());
			}
		} catch {
			// Best-effort — doctor should not fail if a connector can't be imported
		}
	}

	return registrations;
}

/**
 * Resolved plugin registrations for a project, namespaced by kind so
 * connector/transform/logger entries with overlapping ids never collide.
 *
 * Keys: `connector:<id>`, `transform:<name>`, `logger:<name>`.
 */
export interface ResolvePluginsResult {
	/** Single Map of all resolved registrations (consumed by validateProject). */
	registrations: Map<string, ConnectorRegistration | TransformRegistration | LoggerRegistration>;
	/** Plugins that failed to import (formatted "<kind>:<id>"). */
	unresolved: string[];
}

/**
 * Resolve every plugin referenced by a config (connectors, package transforms,
 * loggers) into a single namespaced registrations Map.
 *
 * The map is consumed by {@link validateProject} for per-instance configSchema
 * validation. Unresolved plugins surface as `unresolved` strings rather than
 * throws so the validate command can still run.
 */
export async function resolvePlugins(
	config: OrgLoopConfig,
	projectDir: string,
): Promise<ResolvePluginsResult> {
	const projectImport = createProjectImport(projectDir);
	const registrations = new Map<
		string,
		ConnectorRegistration | TransformRegistration | LoggerRegistration
	>();
	const unresolved: string[] = [];

	// Connectors — keyed by connector ID. Group source/actor configs by their
	// declared connector package and look up once per package.
	const connectorPackages = new Set<string>();
	for (const s of config.sources) connectorPackages.add(s.connector);
	for (const a of config.actors) connectorPackages.add(a.connector);
	const connectorRegistrations = new Map<string, ConnectorRegistration>();
	for (const pkg of connectorPackages) {
		try {
			const mod = await projectImport(pkg);
			if (typeof mod.default === 'function') {
				const reg = (mod.default as () => ConnectorRegistration)();
				connectorRegistrations.set(pkg, reg);
				registrations.set(connectorKey(reg.id), reg);
			} else {
				unresolved.push(`connector:${pkg}`);
			}
		} catch {
			unresolved.push(`connector:${pkg}`);
		}
	}

	// Per-instance: also key by the instance id pointing to its package's reg
	for (const s of config.sources) {
		const reg = connectorRegistrations.get(s.connector);
		if (reg) registrations.set(connectorKey(s.id), reg);
	}
	for (const a of config.actors) {
		const reg = connectorRegistrations.get(a.connector);
		if (reg) registrations.set(connectorKey(a.id), reg);
	}

	// Package transforms — keyed by transform name (definition name).
	for (const t of config.transforms) {
		if (t.type !== 'package' || !t.package) continue;
		try {
			const mod = await projectImport(t.package);
			const transformExport = mod as unknown as { register?: () => TransformRegistration };
			if (typeof transformExport.register === 'function') {
				const reg = transformExport.register();
				registrations.set(transformKey(t.name), reg);
			} else {
				unresolved.push(`transform:${t.name}`);
			}
		} catch {
			unresolved.push(`transform:${t.name}`);
		}
	}

	// Loggers — keyed by logger name (definition name).
	for (const l of config.loggers) {
		try {
			const mod = await projectImport(l.type);
			const loggerExport = mod as unknown as { register?: () => LoggerRegistration };
			if (typeof loggerExport.register === 'function') {
				const reg = loggerExport.register();
				registrations.set(loggerKey(l.name), reg);
			} else {
				unresolved.push(`logger:${l.name}`);
			}
		} catch {
			unresolved.push(`logger:${l.name}`);
		}
	}

	return { registrations, unresolved };
}
