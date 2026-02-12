/**
 * orgloop install-service — Generate platform service file.
 *
 * Auto-detects platform (macOS launchd, Linux systemd) or generates Dockerfile.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { resolveConfigPath } from '../config.js';
import * as output from '../output.js';

// ─── Service file generators ─────────────────────────────────────────────────

function generateLaunchdPlist(configPath: string): string {
	const orgloopBin = 'orgloop';
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.orgloop.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${orgloopBin}</string>
    <string>start</string>
    <string>--config</string>
    <string>${configPath}</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${join(homedir(), '.orgloop')}</string>
  <key>StandardOutPath</key>
  <string>${join(homedir(), '.orgloop', 'logs', 'daemon.stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), '.orgloop', 'logs', 'daemon.stderr.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`;
}

function generateSystemdUnit(configPath: string): string {
	return `[Unit]
Description=OrgLoop — Organization as Code runtime
After=network.target

[Service]
Type=simple
ExecStart=orgloop start --config ${configPath}
WorkingDirectory=${join(homedir(), '.orgloop')}
Restart=on-failure
RestartSec=5
StandardOutput=append:${join(homedir(), '.orgloop', 'logs', 'daemon.stdout.log')}
StandardError=append:${join(homedir(), '.orgloop', 'logs', 'daemon.stderr.log')}

[Install]
WantedBy=default.target`;
}

function generateDockerfile(configPath: string): string {
	return `FROM node:22-slim

WORKDIR /app

# Install orgloop globally
RUN npm install -g orgloop

# Copy configuration
COPY . /app/config/

# Run OrgLoop
CMD ["orgloop", "start", "--config", "/app/config/orgloop.yaml"]`;
}

function generateDockerCompose(): string {
	return `version: "3.8"

services:
  orgloop:
    build: .
    restart: unless-stopped
    volumes:
      - ./:/app/config:ro
      - orgloop-data:/root/.orgloop
    environment:
      - NODE_ENV=production

volumes:
  orgloop-data:`;
}

// ─── Command registration ────────────────────────────────────────────────────

export function registerInstallServiceCommand(program: Command): void {
	program
		.command('install-service')
		.description('Generate platform service file (launchd/systemd/Docker)')
		.option('--launchd', 'Generate macOS LaunchAgent plist')
		.option('--systemd', 'Generate Linux systemd user service')
		.option('--docker', 'Generate Dockerfile + docker-compose.yaml')
		.action(async (opts, cmd) => {
			try {
				const globalOpts = cmd.parent?.opts() ?? {};
				const configPath = resolveConfigPath(globalOpts.config);

				// Determine platform
				let platform: 'launchd' | 'systemd' | 'docker';
				if (opts.launchd) {
					platform = 'launchd';
				} else if (opts.systemd) {
					platform = 'systemd';
				} else if (opts.docker) {
					platform = 'docker';
				} else {
					// Auto-detect
					platform = process.platform === 'darwin' ? 'launchd' : 'systemd';
				}

				if (platform === 'launchd') {
					const plistDir = join(homedir(), 'Library', 'LaunchAgents');
					const plistPath = join(plistDir, 'com.orgloop.daemon.plist');

					await mkdir(plistDir, { recursive: true });
					await mkdir(join(homedir(), '.orgloop', 'logs'), { recursive: true });
					await writeFile(plistPath, generateLaunchdPlist(configPath), 'utf-8');

					output.blank();
					output.info('Detected platform: macOS (launchd)');
					output.info(`Generated: ${plistPath}`);
					output.info('  KeepAlive: true');
					output.info(`  WorkingDirectory: ${join(homedir(), '.orgloop')}`);
					output.info(`  Config: ${configPath}`);
					output.blank();
					output.info('To activate:');
					output.info(`  launchctl load ${plistPath}`);
					output.blank();
					output.info('To deactivate:');
					output.info(`  launchctl unload ${plistPath}`);
				} else if (platform === 'systemd') {
					const unitDir = join(homedir(), '.config', 'systemd', 'user');
					const unitPath = join(unitDir, 'orgloop.service');

					await mkdir(unitDir, { recursive: true });
					await mkdir(join(homedir(), '.orgloop', 'logs'), { recursive: true });
					await writeFile(unitPath, generateSystemdUnit(configPath), 'utf-8');

					output.blank();
					output.info('Detected platform: Linux (systemd)');
					output.info(`Generated: ${unitPath}`);
					output.blank();
					output.info('To activate:');
					output.info('  systemctl --user daemon-reload');
					output.info('  systemctl --user enable --now orgloop');
					output.blank();
					output.info('To deactivate:');
					output.info('  systemctl --user disable --now orgloop');
				} else {
					// Docker
					const dockerfilePath = join(process.cwd(), 'Dockerfile');
					const composePath = join(process.cwd(), 'docker-compose.yaml');

					await writeFile(dockerfilePath, generateDockerfile(configPath), 'utf-8');
					await writeFile(composePath, generateDockerCompose(), 'utf-8');

					output.blank();
					output.info('Generated Docker files:');
					output.info(`  ${dockerfilePath}`);
					output.info(`  ${composePath}`);
					output.blank();
					output.info('To start:');
					output.info('  docker compose up -d');
					output.blank();
					output.info('To stop:');
					output.info('  docker compose down');
				}

				if (output.isJsonMode()) {
					output.json({ platform, config: configPath });
				}
			} catch (err) {
				output.error(`install-service failed: ${err instanceof Error ? err.message : String(err)}`);
				process.exitCode = 1;
			}
		});
}
