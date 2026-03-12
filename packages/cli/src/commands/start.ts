/**
 * orgloop start — Start the runtime with current config.
 *
 * If no daemon is running, starts a new daemon and registers the current
 * directory's module. If a daemon IS running, registers the current
 * directory's module into the existing daemon via the control API.
 *
 * Foreground by default; --daemon forks to background.
 */

import { fork } from 'node:child_process';
import { closeSync, openSync, unlinkSync } from 'node:fs';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { loadCliConfig, resolveConfigPath } from '../config.js';
import { getDaemonInfo, isPortInUse } from '../daemon-client.js';
import { loadDotEnv } from '../dotenv.js';
import { deriveModuleName, readModulesState, registerModule } from '../module-registry.js';
import * as output from '../output.js';
import { createProjectImport } from '../project-import.js';
import { resolveConnectors } from '../resolve-connectors.js';
import { printDoctorResult, runDoctor } from './doctor.js';

const PID_DIR = join(homedir(), '.orgloop');
const PID_FILE = join(PID_DIR, 'orgloop.pid');
const PORT_FILE = join(PID_DIR, 'runtime.port');
const STATE_FILE = join(PID_DIR, 'state.json');
const LOG_DIR = join(PID_DIR, 'logs');

async function cleanupPidFile(): Promise<void> {
	try {
		await unlink(PID_FILE);
	} catch {
		/* ignore */
	}
	try {
		await unlink(PORT_FILE);
	} catch {
		/* ignore */
	}
}

// ─── State persistence ──────────────────────────────────────────────────────

async function saveState(config: import('@orgloop/sdk').OrgLoopConfig): Promise<void> {
	await mkdir(PID_DIR, { recursive: true });

	const state = {
		sources: Object.fromEntries(
			config.sources.map((s) => [
				s.id,
				{ connector: s.connector, poll_interval: s.poll?.interval },
			]),
		),
		actors: Object.fromEntries(config.actors.map((a) => [a.id, { connector: a.connector }])),
		routes: Object.fromEntries(
			config.routes.map((r) => [r.name, { source: r.when.source, actor: r.then.actor }]),
		),
		transforms: Object.fromEntries(config.transforms.map((t) => [t.name, { type: t.type }])),
		loggers: Object.fromEntries(config.loggers.map((l) => [l.name, { type: l.type }])),
	};

	await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// ─── Shared: resolve all connectors/transforms/loggers from config ─────────

async function resolveModuleResources(
	config: import('@orgloop/sdk').OrgLoopConfig,
	projectDir: string,
) {
	const projectImport = createProjectImport(projectDir);

	// Resolve connectors
	const { sources: resolvedSources, actors: resolvedActors } = await resolveConnectors(
		config,
		projectImport as Parameters<typeof resolveConnectors>[1],
	);

	// Resolve package transforms
	const resolvedTransforms = new Map<string, import('@orgloop/sdk').Transform>();
	for (const tDef of config.transforms) {
		if (tDef.type === 'package' && tDef.package) {
			try {
				const mod = await projectImport(tDef.package);
				if (typeof mod.register === 'function') {
					const reg = mod.register() as import('@orgloop/sdk').TransformRegistration;

					// Validate transform config against schema if available
					if (reg.configSchema && tDef.config) {
						try {
							const AjvMod = await import('ajv');
							const AjvClass = AjvMod.default?.default ?? AjvMod.default ?? AjvMod;
							const ajv = new AjvClass({ allErrors: true });
							const validate = ajv.compile(reg.configSchema);
							if (!validate(tDef.config)) {
								const errors = (validate.errors ?? [])
									.map(
										(e: { instancePath?: string; message?: string }) =>
											`${e.instancePath || '/'}: ${e.message}`,
									)
									.join('; ');
								output.warn(
									`Transform "${tDef.name}" config validation failed: ${errors}. Check your transform YAML config matches the expected schema.`,
								);
							}
						} catch {
							// Schema validation is best-effort
						}
					}

					resolvedTransforms.set(tDef.name, new reg.transform());
				}
			} catch (err) {
				output.warn(
					`Transform "${tDef.name}" (${tDef.package}) not available: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	// Resolve loggers
	const resolvedLoggers = new Map<string, import('@orgloop/sdk').Logger>();
	for (const loggerDef of config.loggers) {
		try {
			const mod = await projectImport(loggerDef.type);
			if (typeof mod.register === 'function') {
				const reg = mod.register();
				resolvedLoggers.set(loggerDef.name, new reg.logger());
			}
		} catch (err) {
			output.warn(
				`Logger "${loggerDef.name}" (${loggerDef.type}) not available: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// Create persistent checkpoint store
	let checkpointStore: import('@orgloop/core').FileCheckpointStore | undefined;
	try {
		const { FileCheckpointStore } = await import('@orgloop/core');
		checkpointStore = new FileCheckpointStore();
	} catch {
		// Fall through — runtime will use InMemoryCheckpointStore
	}

	return {
		resolvedSources,
		resolvedActors,
		resolvedTransforms,
		resolvedLoggers,
		checkpointStore,
	};
}

// ─── Register module into a running daemon ──────────────────────────────────

async function registerIntoRunningDaemon(port: number, configPath?: string): Promise<void> {
	const resolvedConfigPath = resolveConfigPath(configPath);
	const projectDir = dirname(resolvedConfigPath);

	output.info('OrgLoop daemon is already running. Registering module...');

	const res = await fetch(`http://127.0.0.1:${port}/control/module/load-project`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			configPath: resolvedConfigPath,
			projectDir: resolve(projectDir),
		}),
		signal: AbortSignal.timeout(30_000),
	});

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `HTTP ${res.status}`);
	}

	const result = (await res.json()) as {
		name: string;
		state: string;
		sources: number;
		actors: number;
		routes: number;
	};

	output.blank();
	output.success(`Module "${result.name}" registered into running daemon`);
	output.info(
		`  State: ${result.state} | Sources: ${result.sources} | Actors: ${result.actors} | Routes: ${result.routes}`,
	);
	output.blank();
	output.info('Run `orgloop status` to see all modules.');
}

// ─── Foreground run ──────────────────────────────────────────────────────────

async function runForeground(configPath?: string, force?: boolean): Promise<void> {
	// Pre-flight: run doctor checks before starting the engine
	if (!force) {
		try {
			const resolvedPath = resolveConfigPath(configPath);
			const doctorResult = await runDoctor(resolvedPath);

			if (doctorResult.status === 'error') {
				printDoctorResult(doctorResult);
				output.blank();
				output.error('Doctor check failed. Fix errors above or use --force to bypass.');
				process.exitCode = 1;
				return;
			}

			if (doctorResult.status === 'degraded') {
				printDoctorResult(doctorResult);
				output.blank();
				output.warn('Proceeding in degraded mode.');
			}
		} catch {
			// Pre-flight is best-effort — fall through to loadCliConfig
		}
	}

	const config = await loadCliConfig({ configPath });

	output.blank();
	output.info('Starting...');
	output.blank();

	// Derive project directory from config path for package resolution
	const projectDir = dirname(resolveConfigPath(configPath));

	// Import Runtime from core — this may fail if core isn't built yet
	let RuntimeClass: typeof import('@orgloop/core').Runtime;

	try {
		const core = await import('@orgloop/core');
		RuntimeClass = core.Runtime;
	} catch {
		// Core not available yet — run in stub mode
		output.warn('OrgLoop core not available — running in config-only mode');
		output.blank();

		// Display what would be started
		for (const s of config.sources) {
			const interval = s.poll?.interval
				? `polling started (every ${s.poll.interval})`
				: 'hook listener started';
			output.success(`Source ${s.id} — ${interval}`);
		}
		for (const a of config.actors) {
			output.success(`Actor ${a.id} — ready`);
		}
		for (const r of config.routes) {
			output.success(`Route ${r.name} — active`);
		}
		for (const l of config.loggers) {
			output.success(`Logger ${l.name} — configured`);
		}

		await saveState(config);

		// Write PID file
		await mkdir(PID_DIR, { recursive: true });
		await writeFile(PID_FILE, String(process.pid), { encoding: 'utf-8', mode: 0o644 });

		output.blank();
		output.info(`OrgLoop is running. PID: ${process.pid}`);
		output.info('Logs: orgloop logs | Status: orgloop status | Stop: orgloop stop');

		// Keep process alive
		const shutdown = async () => {
			output.blank();
			output.info('Shutting down...');
			await cleanupPidFile();
			process.exit(0);
		};

		process.on('SIGTERM', shutdown);
		process.on('SIGINT', shutdown);

		// Block forever
		await new Promise(() => {});
		return;
	}

	// Resolve all module resources
	let resolved: Awaited<ReturnType<typeof resolveModuleResources>>;
	try {
		resolved = await resolveModuleResources(config, projectDir);
	} catch (err) {
		output.error(
			`Connector resolution failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exitCode = 1;
		return;
	}

	// Create Runtime instance and start
	const runtime = new RuntimeClass();

	// Ensure PID/port files are always cleaned up
	process.on('exit', () => {
		for (const f of [PID_FILE, PORT_FILE]) {
			try {
				unlinkSync(f);
			} catch {
				/* ignore */
			}
		}
	});

	// Signal handling — modules.json is NOT cleared here so modules persist across restarts.
	// Only explicit `orgloop stop --all` or `orgloop stop` (last module) clears the registry.
	const shutdown = async () => {
		output.blank();
		output.info('Shutting down...');
		await runtime.stop();
		await cleanupPidFile();
		process.exit(0);
	};

	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);

	try {
		// Start the runtime (scheduler, shared infra)
		await runtime.start();

		// Check for port conflict before binding (issue #95)
		const httpPort = Number(process.env.ORGLOOP_PORT) || 4800;
		if (await isPortInUse(httpPort)) {
			throw new Error(
				`Port ${httpPort} is already in use. A previous daemon may not have released it. ` +
					'Run `orgloop stop --force` to clean up, or set ORGLOOP_PORT to use a different port.',
			);
		}

		// Start HTTP server for control API, webhooks, and REST API
		await runtime.startHttpServer();

		// Register REST API endpoints
		const { registerRestApi } = await import('@orgloop/core');
		registerRestApi(runtime);

		// Register /api/doctor endpoint (needs CLI-level config resolution)
		const resolvedDoctorConfigPath = resolveConfigPath(configPath);
		runtime.getWebhookServer().registerApiHandler('doctor', async () => {
			const { runDoctor: runDoctorCheck } = await import('./doctor.js');
			return runDoctorCheck(resolvedDoctorConfigPath);
		});

		// Register the project loader handler so other CLI processes can add modules
		runtime.registerControlHandler('module/load-project', async (body) => {
			const reqConfigPath = body.configPath as string;
			const reqProjectDir = body.projectDir as string;

			if (!reqConfigPath || !reqProjectDir) {
				throw new Error('configPath and projectDir are required');
			}

			// Load .env from the module's project directory so ${ENV_VAR} references resolve
			await loadDotEnv(reqConfigPath);

			const reqConfig = await loadCliConfig({ configPath: reqConfigPath });
			const moduleName = deriveModuleName(reqConfig.project.name, reqProjectDir);

			// Check if module already loaded — if so, reload it
			const existingModules = runtime.listModules();
			const existing = existingModules.find((m) => (m as { name: string }).name === moduleName);

			if (existing) {
				// Hot-reload: unload then reload
				await runtime.unloadModule(moduleName);
			}

			const reqResolved = await resolveModuleResources(reqConfig, reqProjectDir);

			const moduleConfig: import('@orgloop/core').ModuleConfig = {
				name: moduleName,
				sources: reqConfig.sources,
				actors: reqConfig.actors,
				routes: reqConfig.routes,
				transforms: reqConfig.transforms,
				loggers: reqConfig.loggers,
				defaults: reqConfig.defaults,
				modulePath: resolve(reqProjectDir),
			};

			const status = await runtime.loadModule(moduleConfig, {
				sources: reqResolved.resolvedSources,
				actors: reqResolved.resolvedActors,
				transforms: reqResolved.resolvedTransforms,
				loggers: reqResolved.resolvedLoggers,
				...(reqResolved.checkpointStore ? { checkpointStore: reqResolved.checkpointStore } : {}),
			});

			// Track in modules.json
			await registerModule({
				name: moduleName,
				sourceDir: resolve(reqProjectDir),
				configPath: reqConfigPath,
				loadedAt: new Date().toISOString(),
			});

			return status;
		});

		// Convert config to ModuleConfig and load as a module
		const moduleName = deriveModuleName(config.project.name, projectDir);
		const moduleConfig: import('@orgloop/core').ModuleConfig = {
			name: moduleName,
			sources: config.sources,
			actors: config.actors,
			routes: config.routes,
			transforms: config.transforms,
			loggers: config.loggers,
			defaults: config.defaults,
			modulePath: resolve(projectDir),
		};

		await runtime.loadModule(moduleConfig, {
			sources: resolved.resolvedSources,
			actors: resolved.resolvedActors,
			transforms: resolved.resolvedTransforms,
			loggers: resolved.resolvedLoggers,
			...(resolved.checkpointStore ? { checkpointStore: resolved.checkpointStore } : {}),
		});

		// Track in modules.json
		const resolvedConfigPath = resolveConfigPath(configPath);
		await registerModule({
			name: moduleName,
			sourceDir: resolve(projectDir),
			configPath: resolvedConfigPath,
			loadedAt: new Date().toISOString(),
		});

		// Auto-restore previously registered modules from modules.json
		const persistedState = await readModulesState();
		for (const persisted of persistedState.modules) {
			// Skip the module we just loaded
			if (persisted.name === moduleName) continue;

			// Check that the config file still exists
			try {
				await access(persisted.configPath);
			} catch {
				output.warn(
					`Skipping persisted module "${persisted.name}": config not found at ${persisted.configPath}`,
				);
				continue;
			}

			try {
				// Load .env for the restored module's project directory
				await loadDotEnv(persisted.configPath);

				const restoredConfig = await loadCliConfig({ configPath: persisted.configPath });
				const restoredName = deriveModuleName(restoredConfig.project.name, persisted.sourceDir);
				const restoredResolved = await resolveModuleResources(restoredConfig, persisted.sourceDir);

				const restoredModuleConfig: import('@orgloop/core').ModuleConfig = {
					name: restoredName,
					sources: restoredConfig.sources,
					actors: restoredConfig.actors,
					routes: restoredConfig.routes,
					transforms: restoredConfig.transforms,
					loggers: restoredConfig.loggers,
					defaults: restoredConfig.defaults,
					modulePath: resolve(persisted.sourceDir),
				};

				await runtime.loadModule(restoredModuleConfig, {
					sources: restoredResolved.resolvedSources,
					actors: restoredResolved.resolvedActors,
					transforms: restoredResolved.resolvedTransforms,
					loggers: restoredResolved.resolvedLoggers,
					...(restoredResolved.checkpointStore
						? { checkpointStore: restoredResolved.checkpointStore }
						: {}),
				});

				output.success(`Restored module "${restoredName}" from previous session`);
			} catch (err) {
				output.warn(
					`Failed to restore module "${persisted.name}": ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// Display progress
		for (const s of config.sources) {
			const interval = s.poll?.interval
				? `polling started (every ${s.poll.interval})`
				: 'hook listener started';
			output.success(`Source ${s.id} — ${interval}`);
		}
		for (const a of config.actors) {
			output.success(`Actor ${a.id} — ready`);
		}
		for (const r of config.routes) {
			output.success(`Route ${r.name} — active`);
		}
		for (const l of config.loggers) {
			output.success(`Logger ${l.name} — configured`);
		}

		await saveState(config);

		// Write PID file and port file
		await mkdir(PID_DIR, { recursive: true });
		await writeFile(PID_FILE, String(process.pid), { encoding: 'utf-8', mode: 0o644 });

		const runtimeStatus = runtime.status();
		if (runtimeStatus.httpPort) {
			await writeFile(PORT_FILE, String(runtimeStatus.httpPort), {
				encoding: 'utf-8',
				mode: 0o644,
			});
		}

		// Periodically write health state to state file
		const _healthInterval = setInterval(async () => {
			try {
				const status = runtime.status();
				const state = JSON.parse(await readFile(STATE_FILE, 'utf-8').catch(() => '{}'));
				state.modules = status.modules;
				state.uptime_ms = status.uptime_ms;
				await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
			} catch {
				// Non-fatal: health persistence is best-effort
			}
		}, 10_000);

		output.blank();
		output.info(`OrgLoop is running. PID: ${process.pid}`);
		output.info('Logs: orgloop logs | Status: orgloop status | Stop: orgloop stop');
	} catch (err) {
		await cleanupPidFile();
		output.error(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
		return;
	}

	// Keep process alive (safety net — runtime should already be running)
	await new Promise(() => {});
}

// ─── Shared action handler ───────────────────────────────────────────────────────────────

async function startAction(
	opts: { daemon?: boolean; force?: boolean; supervised?: boolean },
	cmd: { parent?: { opts(): Record<string, unknown> } },
): Promise<void> {
	try {
		const globalOpts = cmd.parent?.opts() ?? {};

		if (opts.daemon) {
			// Check for already-running daemon
			const daemonInfo = await getDaemonInfo();

			if (daemonInfo) {
				// Daemon is running — register this project's module into it
				try {
					await registerIntoRunningDaemon(daemonInfo.port, globalOpts.config as string | undefined);
				} catch (err) {
					output.error(
						`Failed to register module: ${err instanceof Error ? err.message : String(err)}`,
					);
					process.exitCode = 1;
				}
				return;
			}

			// No daemon running — start a new one

			// Pre-flight doctor check before forking
			if (!opts.force) {
				try {
					const configForDoctor = resolveConfigPath(globalOpts.config as string | undefined);
					const doctorResult = await runDoctor(configForDoctor);
					if (doctorResult.status === 'error') {
						printDoctorResult(doctorResult);
						output.blank();
						output.error('Doctor check failed. Fix errors above or use --force to bypass.');
						process.exitCode = 1;
						return;
					}
					if (doctorResult.status === 'degraded') {
						printDoctorResult(doctorResult);
						output.blank();
						output.warn('Proceeding in degraded mode.');
					}
				} catch {
					// Pre-flight is best-effort
				}
			}

			// Fork to background
			await loadCliConfig({ configPath: globalOpts.config as string | undefined });

			// WQ-67: Redirect daemon stdio to log files
			await mkdir(LOG_DIR, { recursive: true });
			const stdoutFd = openSync(join(LOG_DIR, 'daemon.stdout.log'), 'a');
			const stderrFd = openSync(join(LOG_DIR, 'daemon.stderr.log'), 'a');

			output.info('Starting OrgLoop daemon...');

			if (opts.supervised) {
				// WQ-93: Use supervisor for automatic restart on crash
				let SupervisorClass: typeof import('@orgloop/core').Supervisor | undefined;
				try {
					const core = await import('@orgloop/core');
					SupervisorClass = core.Supervisor;
				} catch {
					output.error('Supervisor requires @orgloop/core — falling back to direct fork');
					opts.supervised = false;
				}

				if (opts.supervised && SupervisorClass) {
					const supervisor = new SupervisorClass({
						modulePath: fileURLToPath(import.meta.url),
						env: {
							ORGLOOP_CONFIG: (globalOpts.config as string) ?? '',
						},
						stdio: [stdoutFd, stderrFd],
						maxRestarts: 10,
						crashWindowMs: 300_000,
					});

					supervisor.onLog = (msg) => {
						output.info(msg);
					};

					supervisor.onCrashLoop = () => {
						output.error('Crash loop detected — supervisor giving up');
						closeSync(stdoutFd);
						closeSync(stderrFd);
					};

					await supervisor.start();
					const status = supervisor.status();

					output.success(`OrgLoop daemon started with supervisor. Child PID: ${status.childPid}`);
					output.info(`Logs: ${LOG_DIR}`);

					// Detach supervisor from parent
					process.exit(0);
				}
			}

			// Direct fork (no supervisor) — original behavior
			const child = fork(fileURLToPath(import.meta.url), [], {
				detached: true,
				stdio: ['ignore', stdoutFd, stderrFd, 'ipc'],
				env: {
					...process.env,
					ORGLOOP_CONFIG: (globalOpts.config as string) ?? '',
					ORGLOOP_DAEMON: '1',
				},
			});

			child.unref();
			child.disconnect();
			closeSync(stdoutFd);
			closeSync(stderrFd);

			// WQ-68: Child writes its own PID file after engine.start() — parent just reports
			if (child.pid) {
				output.success(`OrgLoop daemon started. PID: ${child.pid}`);
				output.info(`Logs: ${LOG_DIR}`);
			}
		} else {
			// Check for already-running daemon — auto-register if found (#46)
			const daemonInfo = await getDaemonInfo();

			if (daemonInfo) {
				// Daemon is running — register this project's module into it
				try {
					await registerIntoRunningDaemon(daemonInfo.port, globalOpts.config as string | undefined);
				} catch (err) {
					output.error(
						`Failed to register module: ${err instanceof Error ? err.message : String(err)}`,
					);
					process.exitCode = 1;
				}
				return;
			}

			await runForeground(globalOpts.config as string | undefined, opts.force);
		}
	} catch (err) {
		output.error(`Start failed: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	}
}

// ─── Command registration ──────────────────────────────────────────────────────────────────────

export function registerStartCommand(program: Command): void {
	program
		.command('start')
		.description('Start the runtime or register a module into a running daemon')
		.option('--daemon', 'Run as background daemon')
		.option('--supervised', 'Enable supervisor for auto-restart (requires --daemon)')
		.option('--force', 'Skip doctor pre-flight checks')
		.action(startAction);
}

// Handle being run as a forked daemon child — skip doctor (parent already checked)
if (process.env.ORGLOOP_DAEMON === '1') {
	runForeground(process.env.ORGLOOP_CONFIG || undefined, true).catch((err) => {
		console.error('Daemon failed:', err);
		process.exit(1);
	});
}
