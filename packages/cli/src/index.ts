#!/usr/bin/env node

/**
 * OrgLoop CLI — Organization as Code runtime.
 *
 * Entry point that sets up Commander.js with all commands and global flags.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerAddCommand } from './commands/add.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerEnvCommand } from './commands/env.js';
import { registerHookCommand } from './commands/hook.js';
import { registerInitCommand } from './commands/init.js';
import { registerInspectCommand } from './commands/inspect.js';
import { registerInstallServiceCommand } from './commands/install-service.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerModuleCommand } from './commands/module.js';
import { registerPlanCommand } from './commands/plan.js';
import { registerRoutesCommand } from './commands/routes.js';
import { registerServiceCommand } from './commands/service.js';
import { registerStartCommand } from './commands/start.js';
import { registerStatusCommand } from './commands/status.js';
import { registerStopCommand } from './commands/stop.js';
import { registerTestCommand } from './commands/test.js';
import { registerValidateCommand } from './commands/validate.js';
import { registerVersionCommand } from './commands/version.js';
import { loadDotEnv } from './dotenv.js';
import { setJsonMode, setQuietMode, setVerboseMode } from './output.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function getVersion(): Promise<string> {
	try {
		const pkgPath = resolve(__dirname, '..', 'package.json');
		const content = await readFile(pkgPath, 'utf-8');
		const pkg = JSON.parse(content) as { version: string };
		return pkg.version;
	} catch {
		return '0.0.0';
	}
}

async function main(): Promise<void> {
	const version = await getVersion();

	const program = new Command();

	program
		.name('orgloop')
		.description('OrgLoop — Organization as Code runtime')
		.version(version, '-V, --version', 'Print version number')
		.option('-c, --config <path>', 'Path to orgloop.yaml')
		.option('-w, --workspace <name>', 'Workspace name', 'default')
		.option('-v, --verbose', 'Verbose output')
		.option('--json', 'Output as JSON (for scripting)')
		.option('--quiet', 'Errors only')
		.hook('preAction', async (thisCommand) => {
			const opts = thisCommand.opts();
			if (opts.json) setJsonMode(true);
			if (opts.verbose) setVerboseMode(true);
			if (opts.quiet) setQuietMode(true);
			await loadDotEnv(opts.config);
		});

	// Register all commands
	registerInitCommand(program);
	registerValidateCommand(program);
	registerEnvCommand(program);
	registerDoctorCommand(program);
	registerHookCommand(program);
	registerPlanCommand(program);
	registerStartCommand(program);
	registerStopCommand(program);
	registerStatusCommand(program);
	registerLogsCommand(program);
	registerTestCommand(program);
	registerVersionCommand(program);
	registerRoutesCommand(program);
	registerAddCommand(program);
	registerInspectCommand(program);
	registerInstallServiceCommand(program);
	registerServiceCommand(program);
	registerModuleCommand(program);

	await program.parseAsync(process.argv);
}

main().catch((err) => {
	console.error('Fatal error:', err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});
