/**
 * orgloop add — Scaffold new components.
 *
 * Subcommands: connector, transform, logger, route.
 */

import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
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
		.description('Scaffold a new connector, transform, logger, or route');

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
				output.info(
					'Ensure the connector package is in your package.json: npm install @orgloop/connector-<name>',
				);
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
}
