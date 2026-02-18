/**
 * orgloop init — Scaffold a new OrgLoop project.
 *
 * Interactive mode (default): prompts for project name, description, connectors.
 * Non-interactive: --name, --connectors, --no-interactive flags.
 */

import { readFileSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import type { Command } from 'commander';
import { getEnvVarMeta } from '../env-metadata.js';
import * as output from '../output.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Connectors ──────────────────────────────────────────────────────────────

const AVAILABLE_CONNECTORS = [
	'github',
	'linear',
	'openclaw',
	'claude-code',
	'webhook',
	'slack',
	'pagerduty',
];

/** Map connector short names to npm package names. */
const CONNECTOR_PACKAGES: Record<string, string> = {
	github: '@orgloop/connector-github',
	linear: '@orgloop/connector-linear',
	openclaw: '@orgloop/connector-openclaw',
	'claude-code': '@orgloop/connector-claude-code',
	webhook: '@orgloop/connector-webhook',
	slack: '@orgloop/connector-webhook',
	pagerduty: '@orgloop/connector-webhook',
};

/** Read the CLI's own version to use as a version hint for scaffolded projects. */
function getVersionRange(): string {
	try {
		const pkgPath = resolve(__dirname, '..', '..', 'package.json');
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
		return `^${pkg.version}`;
	} catch {
		return '*';
	}
}

/** Collect npm dependencies needed for a set of connectors. */
function collectProjectDeps(connectors: string[]): Record<string, string> {
	const version = getVersionRange();
	const deps: Record<string, string> = {
		'@orgloop/core': version,
		'@orgloop/logger-file': version,
	};

	for (const conn of connectors) {
		const pkg = CONNECTOR_PACKAGES[conn];
		if (pkg) deps[pkg] = version;
	}

	return Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
}

function connectorYaml(name: string, _role: 'source' | 'actor'): string {
	const configs: Record<string, string> = {
		github: `apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

sources:
  - id: github
    description: GitHub repository events
    connector: "@orgloop/connector-github"
    config:
      repo: "\${GITHUB_REPO}"
      token: "\${GITHUB_TOKEN}"
      events:
        - "pull_request.review_submitted"
        - "pull_request_review_comment"
        - "issue_comment"
        - "pull_request.closed"
        - "pull_request.merged"
        - "workflow_run.completed"
    poll:
      interval: "5m"
    emits:
      - resource.changed
`,

		linear: `apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

sources:
  - id: linear
    description: Linear project tracking events
    connector: "@orgloop/connector-linear"
    config:
      team: "\${LINEAR_TEAM_KEY}"
      api_key: "\${LINEAR_API_KEY}"
    poll:
      interval: "5m"
    emits:
      - resource.changed`,

		openclaw: `apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

actors:
  - id: openclaw-engineering-agent
    description: OpenClaw engineering agent
    connector: "@orgloop/connector-openclaw"
    config:
      base_url: "http://127.0.0.1:18789"
      auth_token_env: "\${OPENCLAW_WEBHOOK_TOKEN}"
      agent_id: "\${OPENCLAW_AGENT_ID}"`,

		'claude-code': `apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

sources:
  - id: claude-code
    description: Claude Code session events
    connector: "@orgloop/connector-claude-code"
    config:
      hook_type: post-exit
    emits:
      - actor.stopped`,

		webhook: `apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

sources:
  - id: webhook
    description: Generic webhook receiver
    connector: "@orgloop/connector-webhook"
    config:
      path: "/webhook"
    emits:
      - resource.changed
      - message.received`,

		slack: `apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

actors:
  - id: slack-notify
    description: Slack notification delivery
    connector: "@orgloop/connector-webhook"
    config:
      url: "\${SLACK_WEBHOOK_URL}"`,

		pagerduty: `apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

actors:
  - id: pagerduty
    description: PagerDuty incident delivery
    connector: "@orgloop/connector-webhook"
    config:
      url: "\${PAGERDUTY_WEBHOOK_URL}"`,
	};
	return configs[name] ?? configs.webhook;
}

function generateOrgloopYaml(name: string, description: string, connectors: string[]): string {
	const connectorRefs = connectors.map((c) => `  - connectors/${c}.yaml`).join('\n');
	return `apiVersion: orgloop/v1alpha1
kind: Project

metadata:
  name: ${name}
  description: "${description}"

defaults:
  poll_interval: "5m"
  event_retention: "30d"
  log_level: info

connectors:
${connectorRefs}

transforms:
  - transforms/transforms.yaml

loggers:
  - loggers/default.yaml
`;
}

function generateDefaultRouteYaml(): string {
	return `apiVersion: orgloop/v1alpha1
kind: RouteGroup

routes:
  - name: example-route
    description: Example route — customize for your setup
    when:
      source: github
      events:
        - resource.changed
    transforms:
      - ref: drop-bot-noise
    then:
      actor: openclaw-engineering-agent
    with:
      prompt_file: ../sops/example.md
`;
}

function generateDefaultTransformsYaml(): string {
	return `apiVersion: orgloop/v1alpha1
kind: TransformGroup

transforms:
  - name: drop-bot-noise
    type: script
    script: ./drop-bot-noise.sh
    timeout_ms: 5000
`;
}

function generateDropBotScript(): string {
	return `#!/usr/bin/env bash
# drop-bot-noise.sh — Drop events from known bot authors.
#
# Reads OrgLoop event JSON from stdin.
# Exit 0 = PASS (forward event), Exit 78 = DROP (discard event).

set -euo pipefail

EVENT=$(cat)
AUTHOR_TYPE=$(echo "$EVENT" | jq -r '.provenance.author_type // "unknown"')

if [ "$AUTHOR_TYPE" = "bot" ]; then
  exit 78  # DROP
fi

# PASS — forward the event unchanged
echo "$EVENT"
exit 0
`;
}

function generateDefaultLoggerYaml(): string {
	return `apiVersion: orgloop/v1alpha1
kind: LoggerGroup

loggers:
  - name: file-log
    type: "@orgloop/logger-file"
    config:
      path: "~/.orgloop/logs/orgloop.log"
      format: jsonl
      rotate:
        max_size: "50MB"
        max_files: 10
`;
}

function generateExampleSop(): string {
	return `# Example Launch Prompt

You are receiving an event from the organization pipeline.

## Context
This event was routed through OrgLoop based on the configured rules.

## Instructions
1. Review the event payload
2. Take appropriate action based on the event type
3. Report completion status

## Constraints
- Do not modify production infrastructure without approval
- Follow the organization's coding standards
- Escalate security-related events immediately
`;
}

// ─── Env var collection ──────────────────────────────────────────────────────

/**
 * Scan connector YAML for ${VAR} references and return a map of
 * var name → connector file that requires it.
 */
export function collectEnvVars(connectors: string[]): Map<string, string> {
	const envVars = new Map<string, string>();
	for (const conn of connectors) {
		const yamlContent = connectorYaml(
			conn,
			['openclaw', 'slack', 'pagerduty'].includes(conn) ? 'actor' : 'source',
		);
		const matches = yamlContent.matchAll(/\$\{([^}]+)\}/g);
		for (const match of matches) {
			envVars.set(match[1], `connectors/${conn}.yaml`);
		}
	}
	return envVars;
}

/**
 * Build the contents for a .env.example file from collected env vars.
 */
export function buildEnvExampleContent(envVars: Map<string, string>): string {
	const lines: string[] = [
		'# OrgLoop environment variables',
		'# Copy to .env and fill in values',
		'',
	];
	for (const [varName] of envVars) {
		const meta = getEnvVarMeta(varName);
		if (meta) {
			lines.push(`# ${meta.description}`);
			if (meta.help_url) lines.push(`# ${meta.help_url}`);
		}
		lines.push(`# ${varName}=`);
		lines.push('');
	}
	return lines.join('\n');
}

// ─── File creation ───────────────────────────────────────────────────────────

async function dirExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function scaffoldProject(
	targetDir: string,
	name: string,
	description: string,
	connectors: string[],
): Promise<string[]> {
	const created: string[] = [];

	// Create directories
	await mkdir(join(targetDir, 'connectors'), { recursive: true });
	await mkdir(join(targetDir, 'routes'), { recursive: true });
	await mkdir(join(targetDir, 'transforms'), { recursive: true });
	await mkdir(join(targetDir, 'loggers'), { recursive: true });
	await mkdir(join(targetDir, 'sops'), { recursive: true });

	// orgloop.yaml
	const orgloopPath = join(targetDir, 'orgloop.yaml');
	await writeFile(orgloopPath, generateOrgloopYaml(name, description, connectors), 'utf-8');
	created.push('orgloop.yaml');

	// Connector files
	for (const conn of connectors) {
		const connPath = join(targetDir, 'connectors', `${conn}.yaml`);
		const role = ['openclaw', 'slack', 'pagerduty'].includes(conn) ? 'actor' : 'source';
		await writeFile(connPath, connectorYaml(conn, role), 'utf-8');
		created.push(`connectors/${conn}.yaml`);
	}

	// Route files
	const routePath = join(targetDir, 'routes', 'example.yaml');
	await writeFile(routePath, generateDefaultRouteYaml(), 'utf-8');
	created.push('routes/example.yaml');

	// Logger files
	const loggerPath = join(targetDir, 'loggers', 'default.yaml');
	await writeFile(loggerPath, generateDefaultLoggerYaml(), 'utf-8');
	created.push('loggers/default.yaml');

	// Transform files
	const transformsYamlPath = join(targetDir, 'transforms', 'transforms.yaml');
	await writeFile(transformsYamlPath, generateDefaultTransformsYaml(), 'utf-8');
	created.push('transforms/transforms.yaml');

	const scriptPath = join(targetDir, 'transforms', 'drop-bot-noise.sh');
	await writeFile(scriptPath, generateDropBotScript(), 'utf-8');
	const { chmod } = await import('node:fs/promises');
	await chmod(scriptPath, 0o755);
	created.push('transforms/drop-bot-noise.sh');

	// SOP files
	const sopPath = join(targetDir, 'sops', 'example.md');
	await writeFile(sopPath, generateExampleSop(), 'utf-8');
	created.push('sops/example.md');

	// Generate package.json with connector/transform/logger dependencies
	const packageJsonPath = join(targetDir, 'package.json');
	if (!(await dirExists(packageJsonPath))) {
		const packageJson = {
			private: true,
			description: `OrgLoop project: ${name}`,
			dependencies: collectProjectDeps(connectors),
		};
		await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf-8');
		created.push('package.json');
	}

	// Generate .env.example
	const envVars = collectEnvVars(connectors);
	if (envVars.size > 0) {
		await writeFile(join(targetDir, '.env.example'), buildEnvExampleContent(envVars), 'utf-8');
		created.push('.env.example');
	}

	// Generate .gitignore (only if it doesn't already exist)
	const gitignorePath = join(targetDir, '.gitignore');
	if (!(await dirExists(gitignorePath))) {
		const gitignoreContent = `# Environment variables (contains secrets)
.env
.env.local

# OrgLoop runtime
.orgloop/

# Node
node_modules/
dist/
`;
		await writeFile(gitignorePath, gitignoreContent, 'utf-8');
		created.push('.gitignore');
	}

	return created;
}

// ─── Claude Code hook helpers (exported for testing) ─────────────────────────

/**
 * Build a Claude Code Stop hook entry in the object format expected by
 * Claude Code's settings.json.
 */
export function buildClaudeCodeHookEntry(command: string) {
	return {
		matcher: '',
		hooks: [{ type: 'command', command }],
	};
}

/**
 * Check whether a Stop hooks array already contains an orgloop hook.
 * Handles the object format: [{ matcher, hooks: [{ type, command }] }].
 */
export function hasExistingOrgloopHook(stopHooks: unknown[]): boolean {
	return stopHooks.some((entry) => {
		if (typeof entry !== 'object' || entry === null) return false;
		const obj = entry as Record<string, unknown>;
		const innerHooks = obj.hooks as Array<Record<string, unknown>> | undefined;
		return innerHooks?.some((h) => typeof h.command === 'string' && h.command.includes('orgloop'));
	});
}

/**
 * Merge an orgloop hook into a settings object. Returns the updated settings
 * and a boolean indicating whether the hook was already present.
 */
export function mergeClaudeCodeHook(
	settings: Record<string, unknown>,
	hookCommand: string,
): { settings: Record<string, unknown>; alreadyInstalled: boolean } {
	const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
	const stopHooks = (hooks.Stop ?? []) as unknown[];

	if (hasExistingOrgloopHook(stopHooks)) {
		return { settings, alreadyInstalled: true };
	}

	stopHooks.push(buildClaudeCodeHookEntry(hookCommand));
	hooks.Stop = stopHooks;
	settings.hooks = hooks;
	return { settings, alreadyInstalled: false };
}

// ─── Claude Code hook onboarding ──────────────────────────────────────────────

async function promptClaudeCodeHook(): Promise<void> {
	const { default: inquirer } = await import('inquirer');

	const { scope } = await inquirer.prompt([
		{
			type: 'list',
			name: 'scope',
			message: 'Install OrgLoop hook to Claude Code settings?',
			choices: [
				{ name: 'Global (~/.claude/settings.json)', value: 'global' },
				{ name: 'Project (.claude/settings.json)', value: 'project' },
				{ name: 'Skip', value: 'skip' },
			],
		},
	]);

	if (scope === 'skip') return;

	const settingsPath =
		scope === 'global'
			? join(homedir(), '.claude', 'settings.json')
			: join(process.cwd(), '.claude', 'settings.json');

	const hookCommand = 'orgloop hook claude-code-stop';

	try {
		let settings: Record<string, unknown> = {};
		try {
			const content = await readFile(settingsPath, 'utf-8');
			settings = JSON.parse(content);
		} catch {
			// File doesn't exist yet
		}

		const result = mergeClaudeCodeHook(settings, hookCommand);
		if (result.alreadyInstalled) {
			output.info('  OrgLoop hook already installed in Claude Code settings.');
			return;
		}

		await mkdir(join(settingsPath, '..'), { recursive: true });
		await writeFile(settingsPath, `${JSON.stringify(result.settings, null, 2)}\n`, 'utf-8');
		output.success(`  Installed Claude Code Stop hook → ${chalk.dim(settingsPath)}`);
	} catch (err) {
		output.warn(`  Could not install hook: ${err instanceof Error ? err.message : String(err)}`);
		output.info(`  Manually add to ${settingsPath}:`);
		output.info(
			`    "hooks": { "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "${hookCommand}" }] }] }`,
		);
	}
}

// ─── Command registration ────────────────────────────────────────────────────

export function registerInitCommand(program: Command): void {
	program
		.command('init')
		.description('Scaffold a new OrgLoop project')
		.option('--name <name>', 'Project name')
		.option('--description <desc>', 'Project description')
		.option('--connectors <list>', 'Comma-separated connector list')
		.option('--no-interactive', 'Disable interactive prompts')
		.option('--dir <path>', 'Target directory (default: current directory)')
		.action(async (opts) => {
			try {
				const targetDir = opts.dir ? resolve(opts.dir) : process.cwd();

				let name: string;
				let description: string;
				let connectors: string[];

				if (opts.interactive === false) {
					// Non-interactive mode
					name = opts.name ?? 'my-org';
					description = opts.description ?? 'OrgLoop project';
					connectors = opts.connectors
						? (opts.connectors as string).split(',').map((c: string) => c.trim())
						: ['github'];
				} else {
					// Interactive mode
					const { default: inquirer } = await import('inquirer');
					const answers = await inquirer.prompt([
						{
							type: 'input',
							name: 'name',
							message: 'Project name:',
							default: opts.name ?? 'my-org',
						},
						{
							type: 'input',
							name: 'description',
							message: 'Description:',
							default: opts.description ?? 'Organization event routing',
						},
						{
							type: 'checkbox',
							name: 'connectors',
							message: 'Which connectors?',
							choices: AVAILABLE_CONNECTORS.map((c) => ({
								name: c.charAt(0).toUpperCase() + c.slice(1),
								value: c,
								checked: ['github', 'linear', 'openclaw', 'claude-code'].includes(c),
							})),
						},
					]);
					name = answers.name as string;
					description = answers.description as string;
					connectors = answers.connectors as string[];
				}

				// Validate connectors
				for (const c of connectors) {
					if (!AVAILABLE_CONNECTORS.includes(c)) {
						output.error(`Unknown connector: ${c}`);
						output.info(`Available: ${AVAILABLE_CONNECTORS.join(', ')}`);
						process.exitCode = 1;
						return;
					}
				}

				// Check for existing orgloop.yaml
				if (await dirExists(join(targetDir, 'orgloop.yaml'))) {
					output.error('orgloop.yaml already exists in this directory.');
					output.info('Use a different directory or remove the existing file.');
					process.exitCode = 1;
					return;
				}

				const created = await scaffoldProject(targetDir, name, description, connectors);

				output.blank();
				output.heading('Created:');
				for (const file of created) {
					output.info(`  ${file}`);
				}

				// Show env var status with ✓/✗ indicators
				const envVars = collectEnvVars(connectors);

				if (envVars.size > 0) {
					output.blank();
					output.heading('Environment variables:');
					for (const [varName, file] of envVars) {
						const isSet = process.env[varName] !== undefined;
						const icon = isSet ? chalk.green('✓') : chalk.red('✗');
						output.info(`  ${icon} ${chalk.yellow(varName.padEnd(22))} ${chalk.dim(file)}`);
						if (!isSet) {
							const meta = getEnvVarMeta(varName);
							if (meta) {
								output.info(`    ${chalk.dim('\u2192')} ${meta.description}`);
								if (meta.help_url) {
									output.info(`    ${chalk.dim('\u2192')} ${chalk.cyan(meta.help_url)}`);
								}
							}
						}
					}
				}

				// Claude Code hook onboarding
				if (connectors.includes('claude-code') && opts.interactive !== false) {
					output.blank();
					await promptClaudeCodeHook();
				}

				output.blank();
				output.info(
					chalk.dim(
						'Next: run `npm install` to install dependencies, then `orgloop doctor` to check your environment.',
					),
				);
			} catch (err) {
				output.error(`Init failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});
}
