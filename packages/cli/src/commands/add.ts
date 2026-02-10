/**
 * orgloop add — Scaffold new components.
 *
 * Subcommands: connector, transform, logger, route, module.
 */

import { access, chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import yaml from 'js-yaml';
import { expandModuleRoutes, loadModuleManifest, resolveModulePath } from '../module-resolver.js';
import * as output from '../output.js';

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

// ─── Generators ──────────────────────────────────────────────────────────────

function connectorYaml(name: string, type: string): string {
	if (type === 'actor') {
		return `apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

actors:
  - id: ${name}
    description: ${name} actor
    connector: "@orgloop/connector-webhook"
    config:
      url: "\${${name.toUpperCase().replace(/-/g, '_')}_URL}"
`;
	}

	return `apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

sources:
  - id: ${name}
    description: ${name} source
    connector: "@orgloop/connector-webhook"
    config:
      path: "/${name}"
    poll:
      interval: "5m"
    emits:
      - resource.changed
`;
}

function transformScript(name: string): string {
	return `#!/usr/bin/env bash
# ${name} — Custom transform script.
#
# Reads OrgLoop event JSON from stdin.
# Exit 0 = PASS (forward event), Exit 78 = DROP (discard event).
# Output modified event JSON to stdout.

set -euo pipefail

EVENT=$(cat)

# TODO: Add your transform logic here

# PASS — forward the event unchanged
echo "$EVENT"
exit 0
`;
}

function transformYaml(name: string, type: string): string {
	if (type === 'script') {
		return `apiVersion: orgloop/v1alpha1
kind: TransformGroup

transforms:
  - name: ${name}
    type: script
    script: ./${name}.sh
    timeout_ms: 5000
`;
	}

	return `apiVersion: orgloop/v1alpha1
kind: TransformGroup

transforms:
  - name: ${name}
    type: package
    package: "./${name}"
    timeout_ms: 30000
`;
}

function loggerYaml(name: string): string {
	return `apiVersion: orgloop/v1alpha1
kind: LoggerGroup

loggers:
  - name: ${name}
    type: "@orgloop/logger-file"
    config:
      path: "~/.orgloop/logs/${name}.log"
      format: jsonl
`;
}

function routeYaml(name: string, source: string, actor: string): string {
	return `apiVersion: orgloop/v1alpha1
kind: RouteGroup

routes:
  - name: ${name}
    description: Route from ${source} to ${actor}
    when:
      source: ${source}
      events:
        - resource.changed
    then:
      actor: ${actor}
`;
}

// ─── Command registration ────────────────────────────────────────────────────

export function registerAddCommand(program: Command): void {
	const addCmd = program
		.command('add')
		.description('Scaffold a new connector, transform, logger, route, or module');

	// orgloop add connector <name>
	addCmd
		.command('connector <name>')
		.description('Add a new connector')
		.option('--type <type>', 'Connector type: source or actor', 'source')
		.action(async (name: string, opts) => {
			try {
				const dir = resolve(process.cwd(), 'connectors');
				await mkdir(dir, { recursive: true });

				const filePath = join(dir, `${name}.yaml`);
				if (await fileExists(filePath)) {
					output.error(`Connector file already exists: connectors/${name}.yaml`);
					process.exitCode = 1;
					return;
				}

				await writeFile(filePath, connectorYaml(name, opts.type), 'utf-8');
				output.success(`Created connectors/${name}.yaml`);
				output.info(`Add "connectors/${name}.yaml" to your orgloop.yaml connectors list.`);
			} catch (err) {
				output.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});

	// orgloop add transform <name>
	addCmd
		.command('transform <name>')
		.description('Add a new transform')
		.option('--type <type>', 'Transform type: script or package', 'script')
		.action(async (name: string, opts) => {
			try {
				const dir = resolve(process.cwd(), 'transforms');
				await mkdir(dir, { recursive: true });

				if (opts.type === 'script') {
					const scriptPath = join(dir, `${name}.sh`);
					if (await fileExists(scriptPath)) {
						output.error(`Transform script already exists: transforms/${name}.sh`);
						process.exitCode = 1;
						return;
					}
					await writeFile(scriptPath, transformScript(name), 'utf-8');
					await chmod(scriptPath, 0o755);
					output.success(`Created transforms/${name}.sh`);
				}

				const yamlPath = join(dir, `${name}.yaml`);
				await writeFile(yamlPath, transformYaml(name, opts.type), 'utf-8');
				output.success(`Created transforms/${name}.yaml`);
				output.info(`Add "transforms/${name}.yaml" to your orgloop.yaml transforms list.`);
			} catch (err) {
				output.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});

	// orgloop add logger <name>
	addCmd
		.command('logger <name>')
		.description('Add a new logger')
		.action(async (name: string) => {
			try {
				const dir = resolve(process.cwd(), 'loggers');
				await mkdir(dir, { recursive: true });

				const filePath = join(dir, `${name}.yaml`);
				if (await fileExists(filePath)) {
					output.error(`Logger file already exists: loggers/${name}.yaml`);
					process.exitCode = 1;
					return;
				}

				await writeFile(filePath, loggerYaml(name), 'utf-8');
				output.success(`Created loggers/${name}.yaml`);
				output.info(`Add "loggers/${name}.yaml" to your orgloop.yaml loggers list.`);
			} catch (err) {
				output.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});

	// orgloop add route <name>
	addCmd
		.command('route <name>')
		.description('Add a new route')
		.option('--source <source>', 'Source ID', 'github')
		.option('--actor <actor>', 'Actor ID', 'openclaw-engineering-agent')
		.action(async (name: string, opts) => {
			try {
				const dir = resolve(process.cwd(), 'routes');
				await mkdir(dir, { recursive: true });

				const filePath = join(dir, `${name}.yaml`);
				if (await fileExists(filePath)) {
					output.error(`Route file already exists: routes/${name}.yaml`);
					process.exitCode = 1;
					return;
				}

				await writeFile(filePath, routeYaml(name, opts.source, opts.actor), 'utf-8');
				output.success(`Created routes/${name}.yaml`);
			} catch (err) {
				output.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});

	// orgloop add module <name>
	addCmd
		.command('module <name>')
		.description('Install a workflow module')
		.option('--path <path>', 'Local module path (for development)')
		.option('--no-interactive', 'Disable interactive prompts')
		.option('--params <json>', 'Parameters as JSON (non-interactive)')
		.action(async (name: string, opts) => {
			try {
				const cwd = process.cwd();
				const configPath = resolve(cwd, 'orgloop.yaml');

				if (!(await fileExists(configPath))) {
					output.error('No orgloop.yaml found. Run `orgloop init` first.');
					process.exitCode = 1;
					return;
				}

				// Resolve module path
				const modulePath = opts.path ? resolve(cwd, opts.path) : resolveModulePath(name, cwd);

				// Load manifest
				const manifest = await loadModuleManifest(modulePath);
				output.success(`Found module: ${manifest.metadata.name} (${manifest.metadata.version})`);

				// Collect parameters
				let params: Record<string, string | number | boolean> = {};

				if (opts.params) {
					params = JSON.parse(opts.params);
				} else if (opts.interactive !== false) {
					const { default: inquirer } = await import('inquirer');
					const questions = (manifest.parameters ?? []).map((p) => ({
						type: 'input' as const,
						name: p.name,
						message: `${p.description}:`,
						default: p.default !== undefined ? String(p.default) : undefined,
					}));

					if (questions.length > 0) {
						output.blank();
						output.heading('Module parameters:');
						params = await inquirer.prompt(questions);
					}
				} else {
					// Non-interactive: use defaults
					for (const p of manifest.parameters ?? []) {
						if (p.default !== undefined) {
							params[p.name] = p.default;
						} else if (p.required) {
							output.error(
								`Missing required parameter "${p.name}". Use --params or run interactively.`,
							);
							process.exitCode = 1;
							return;
						}
					}
				}

				// Expand routes to validate
				const routes = await expandModuleRoutes(modulePath, manifest, params);

				// Scaffold bundled files (connectors, transforms, loggers, SOPs)
				const scaffoldDirs = ['connectors', 'transforms', 'loggers', 'sops'] as const;
				const connectorFiles: string[] = [];
				const transformFiles: string[] = [];
				const loggerFiles: string[] = [];

				for (const dir of scaffoldDirs) {
					const moduleDir = join(modulePath, dir);
					if (!(await fileExists(moduleDir))) continue;

					const projectDir = resolve(cwd, dir);
					await mkdir(projectDir, { recursive: true });

					const { readdir: rd } = await import('node:fs/promises');
					const files = await rd(moduleDir);
					for (const file of files) {
						const destPath = join(projectDir, file);
						if (await fileExists(destPath)) continue; // Don't overwrite existing

						await cp(join(moduleDir, file), destPath, { recursive: true });
						output.success(`Created ${dir}/${file}`);

						// Track YAML files for orgloop.yaml references
						if (file.endsWith('.yaml') || file.endsWith('.yml')) {
							if (dir === 'connectors') connectorFiles.push(`connectors/${file}`);
							if (dir === 'transforms') transformFiles.push(`transforms/${file}`);
							if (dir === 'loggers') loggerFiles.push(`loggers/${file}`);
						}
					}
				}

				// Merge into orgloop.yaml
				const rawConfig = await readFile(configPath, 'utf-8');
				const config = yaml.load(rawConfig) as Record<string, unknown>;

				// Add connector/transform/logger refs
				const existingConnectors = (config.connectors ?? []) as string[];
				for (const f of connectorFiles) {
					if (!existingConnectors.includes(f)) existingConnectors.push(f);
				}
				if (existingConnectors.length) config.connectors = existingConnectors;

				const existingTransforms = (config.transforms ?? []) as string[];
				for (const f of transformFiles) {
					if (!existingTransforms.includes(f)) existingTransforms.push(f);
				}
				if (existingTransforms.length) config.transforms = existingTransforms;

				const existingLoggers = (config.loggers ?? []) as string[];
				for (const f of loggerFiles) {
					if (!existingLoggers.includes(f)) existingLoggers.push(f);
				}
				if (existingLoggers.length) config.loggers = existingLoggers;

				// Add module entry
				const modules = (config.modules ?? []) as Array<{
					package: string;
					params: Record<string, string | number | boolean>;
				}>;

				const packageRef = opts.path ?? name;
				const existing = modules.find((m) => m.package === packageRef || m.package === name);
				if (existing) {
					output.warn(`Module "${name}" is already installed. Updating parameters.`);
					existing.params = params;
				} else {
					modules.push({
						package: packageRef,
						params,
					});
				}
				config.modules = modules;

				await writeFile(configPath, yaml.dump(config, { lineWidth: 100 }), 'utf-8');

				output.blank();
				output.success(`Module "${manifest.metadata.name}" installed`);
				output.info(`  ${routes.length} route(s) will be added at runtime`);
				if (connectorFiles.length) {
					output.info(`  ${connectorFiles.length} connector(s) scaffolded`);
				}
				output.blank();
				output.info('Next: run `orgloop doctor` to check your environment.');
			} catch (err) {
				output.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});
}
