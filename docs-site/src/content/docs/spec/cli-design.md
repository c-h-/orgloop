---
title: "CLI Design"
description: "Complete command reference, interactive flows, output formatting, and configuration resolution for the orgloop CLI."
---

### 8.1 Command Reference

```
orgloop — Organization as Code runtime

USAGE:
  orgloop <command> [options]

COMMANDS:
  init              Scaffold a new OrgLoop project
  validate          Validate configuration files
  plan              Show what would change (dry run)
  start             Start the runtime (--daemon, --supervised, --force)
  stop              Stop the current module (or daemon if last module)
  shutdown          Stop the daemon and all modules unconditionally
  status            Show runtime status, all modules, sources, actors, recent events
  logs              Tail or query the event log
  test              Inject a test event and trace its path
  add               Scaffold a new connector, transform, logger, or route
  inspect           Deep-dive into a specific source, actor, or route
  routes            Visualize the routing topology
  hook              Forward hook events to running OrgLoop engine
  install-service   Generate platform service file (launchd/systemd/Docker)
  service           Manage the installed service (start/stop/status/logs)
  version           Print version info

  env               Check environment variable configuration
  doctor            Pre-flight environment validation

FLAGS:
  --config, -c      Path to orgloop.yaml (default: ./orgloop.yaml)
  --verbose, -v     Verbose output
  --json            Output as JSON (for scripting)
  --help, -h        Show help
```

### 8.2 Command Details

#### `orgloop init`

```bash
$ orgloop init

? Project name: my-org
? Description: Engineering organization event routing
? Which connectors? (space to select)
  ◉ GitHub
  ◉ Linear
  ◉ OpenClaw
  ◉ Claude Code
  ○ Webhook (generic)
  ○ Slack
  ○ PagerDuty

Created:
  orgloop.yaml
  connectors/github.yaml
  connectors/linear.yaml
  connectors/openclaw.yaml
  connectors/claude-code.yaml
  routes/example.yaml
  loggers/default.yaml
  transforms/transforms.yaml
  transforms/drop-bot-noise.sh
  sops/example.md

Required environment variables:
  GITHUB_REPO            connectors/github.yaml
  GITHUB_TOKEN           connectors/github.yaml
  LINEAR_TEAM            connectors/linear.yaml
  LINEAR_TOKEN           connectors/linear.yaml
  OPENCLAW_AGENT         connectors/openclaw.yaml
  OPENCLAW_TOKEN         connectors/openclaw.yaml

? Install OrgLoop hook to Claude Code settings? (Use arrow keys)
  > Global (~/.claude/settings.json)
    Project (.claude/settings.json)
    Skip

  ✓ Installed Claude Code Stop hook → ~/.claude/settings.json

Next: edit your connector configs, then run `orgloop validate`
```

After scaffolding, `init` automatically:
1. Scans generated YAML for `${VAR_NAME}` patterns and displays required env vars
2. If `claude-code` is selected, offers to install the OrgLoop Stop hook into Claude Code settings (global or project scope), checking for existing installation to avoid duplicates

Non-interactive mode:
```bash
orgloop init --name my-org --connectors github,linear,openclaw --no-interactive
```

For the project config schema and YAML file formats, see the [Project Model](./modules/) spec.

#### `orgloop validate`

```bash
$ orgloop validate

✓ orgloop.yaml — valid project manifest
✓ connectors/github.yaml — valid source definition
✓ connectors/openclaw.yaml — valid actor definition
✗ routes/engineering.yaml — error at routes[0].transforms[1]:
    Transform "my-filter" not found.
✓ loggers/default.yaml — valid logger group

1 error, 0 warnings
```

Validates:
- YAML syntax
- Schema conformance (against JSON Schema)
- Reference integrity (routes reference existing sources, actors, transforms)
- Connector config completeness (required fields present)
- Transform script existence and permissions (executable bit)
- Launch prompt file existence (routes with `with.prompt_file`)

#### `orgloop plan`

```bash
$ orgloop plan

OrgLoop Plan — my-org

  Sources:
    + github          (new — poll every 5m)
    + linear          (new — poll every 5m)
    ~ claude-code     (changed — secret added)

  Actors:
    = openclaw-engineering-agent  (unchanged)

  Routes:
    + github-to-engineering       (new)
    + linear-to-project           (new)
    + claude-code-to-supervisor   (new)

  Transforms:
    + drop-bot-noise              (new — script)
    + dedup                       (new — package)

  Loggers:
    = file-log                    (unchanged)
    + console-log                 (new)

Plan: 5 to add, 1 to change, 0 to remove.

Run `orgloop start` to execute this plan.
```

#### `orgloop start`

```bash
$ orgloop start

Applying plan...

  ✓ Source github — polling started (every 5m)
  ✓ Source linear — polling started (every 5m)
  ✓ Source claude-code — hook listener started
  ✓ Actor openclaw-engineering-agent — ready
  ✓ Route github-to-engineering — active
  ✓ Route linear-to-project — active
  ✓ Route claude-code-to-supervisor — active
  ✓ Logger file-log — writing to ~/.orgloop/logs/orgloop.log
  ✓ Logger console-log — streaming to stdout

OrgLoop is running. PID: 42891
Logs: orgloop logs | Status: orgloop status | Stop: orgloop stop
```

`orgloop start` starts the runtime as a **long-running daemon process**. It manages all source polling internally — poll intervals are declared in the YAML spec, not in external schedulers. This single process replaces N separate pollers/LaunchAgents/cron jobs.

Under the hood, `start` creates a `Runtime` instance, starts the HTTP control API, resolves connectors, and loads the project config. The CLI's `resolveConnectors()` dynamically imports all referenced connector packages and instantiates source/actor instances. If a connector package is missing, the CLI suggests `pnpm add <package>`.

**Multi-module behavior:** `start` is module-aware. If a daemon is already running (detected via PID file and process check), `start` registers the current directory's module into the running daemon via the control API instead of starting a new daemon. This allows multiple OrgLoop projects to share a single daemon process.

- If the module is already loaded (same name), it performs a hot-reload (unload + load).
- Module state is tracked in `~/.orgloop/modules.json` so other CLI commands (`stop`, `status`) can map directories to module names.

```bash
# Foreground (development, debugging)
orgloop start

# Daemon mode (production)
orgloop start --daemon
# PID written to ~/.orgloop/orgloop.pid

# Supervised daemon (auto-restarts on crash)
orgloop start --daemon --supervised

# Start a second project into the same running daemon
cd ~/projects/another-org
orgloop start --daemon
# Module registered into existing daemon — no new process
```

#### `orgloop stop`

```bash
# In a project directory with one module running:
$ orgloop stop
Module "engineering-org" is the last module. Shutting down daemon.
Stopping OrgLoop daemon (PID 42891)...
Stopped.

# In a project directory when multiple modules are running:
$ orgloop stop
Unloading module "engineering-org"...
Module "engineering-org" stopped. Daemon continues with 1 module(s).
```

`orgloop stop` is **module-aware**. It determines which module the current directory owns and stops only that module:

- If this is the **last module**, the daemon shuts down entirely.
- If **other modules** are still running, only this module is unloaded and the daemon continues.
- Use `--all` to unconditionally stop the daemon and all modules (alias for `orgloop shutdown`).
- Use `--force` to send SIGKILL instead of graceful shutdown.

Graceful shutdown: first attempts to shut down via the HTTP control API (`POST /control/shutdown`), falling back to SIGTERM if the control API is unreachable. Either path flushes log buffers, persists current checkpoints, waits for in-flight deliveries (with timeout), then exits.

#### `orgloop shutdown`

```bash
$ orgloop shutdown

Stopping OrgLoop daemon (PID 42891)...
Requesting graceful shutdown via control API...
Stopped.
```

Unconditionally stops the daemon and all loaded modules. Unlike `stop`, which is module-aware and only removes the current directory's module, `shutdown` always takes down the entire daemon. Use `--force` for immediate SIGKILL.

#### `orgloop status`

Queries the running runtime's HTTP control API (`GET /control/status`) for a status snapshot. When multiple modules are loaded, shows all modules and their resources.

```bash
$ orgloop status

OrgLoop Runtime
  Status: running (PID 42891, uptime 3h 22m)
  Control API: http://127.0.0.1:4800

Modules (2):
  NAME               DIR                          STATE   SOURCES  ROUTES
  engineering-org    ~/projects/engineering-org    active  3        3
  ops-org            ~/projects/ops-org            active  1        2

Sources:
  NAME          TYPE     INTERVAL  LAST POLL           EVENTS (24h)
  github        poll     5m        2 min ago           47
  linear        poll     5m        3 min ago           12
  claude-code   hook     —         18 min ago          3

Actors:
  NAME            STATUS    DELIVERIES (24h)  ERRORS
  openclaw-engineering-agent  healthy  62                0

Routes:
  NAME                        MATCHED (24h)  DROPPED  ERRORS
  github-to-engineering       45             2        0
  linear-to-project           12             0        0
  claude-code-to-supervisor   3              0        0

Recent Events (last 5):
  TIME          SOURCE    TYPE              ROUTE                      STATUS
  20:47:12      github    resource.changed  github-to-engineering      delivered
  20:47:12      github    resource.changed  github-to-engineering      dropped (bot)
  20:42:08      linear    resource.changed  linear-to-project          delivered
  20:18:33      cc        actor.stopped     claude-code-to-supervisor  delivered
  20:15:01      github    resource.changed  github-to-engineering      delivered
```

#### `orgloop logs`

```bash
# Tail all logs
$ orgloop logs

# Tail logs for a specific source
$ orgloop logs --source github

# Tail logs for a specific route
$ orgloop logs --route github-to-engineering

# Query historical logs
$ orgloop logs --since 2h --event-type resource.changed --format json

# Show only drops (filtered events)
$ orgloop logs --result drop

# Show a specific event's full trace
$ orgloop logs --event evt_abc123
```

#### `orgloop test`

```bash
# Inject a test event from a file
$ orgloop test event.json

Injecting test event: resource.changed (source: github)

  ✓ Transform: drop-bot-noise — PASS (2ms)
  ✓ Transform: dedup — PASS (1ms)
  ✓ Route match: github-to-engineering
  ✓ Delivery: openclaw-engineering-agent — 200 OK (89ms)

Event evt_test_001 traced successfully through 1 route.

# Inject with dry-run (no actual delivery)
$ orgloop test event.json --dry-run

# Generate a sample event for a connector
$ orgloop test --generate github
# Writes a sample event to stdout that you can pipe back in

# Inject from stdin
$ echo '{"type":"resource.changed","source":"github",...}' | orgloop test -
```

#### `orgloop env`

```bash
$ orgloop env

Environment Variables:

  ✓ GITHUB_TOKEN       connectors/github.yaml
  ✗ LINEAR_API_KEY     connectors/linear.yaml
    → Linear personal API key
    → https://linear.app/settings/api
  ✓ OPENCLAW_WEBHOOK_TOKEN  connectors/openclaw.yaml

2 of 3 variables set. 1 missing.
```

Scans all YAML files for `${VAR_NAME}` references. Shows set/unset status with color indicators. When connector setup metadata is available (see [7.4 Connector Setup Metadata](./plugin-system/)), missing variables show description and help URL.

```bash
# Strict mode (CI) — exits with code 1 if any missing
$ orgloop env check

# Machine-readable output
$ orgloop env --json
```

#### `orgloop doctor`

```bash
$ orgloop doctor

OrgLoop Doctor — my-org

  Packages:
    ✓ @orgloop/connector-github (1.2.0)
    ✓ @orgloop/connector-openclaw (1.0.3)
    ✗ @orgloop/connector-claude-code — not installed
      Fix: npm install @orgloop/connector-claude-code

  Services:
    ✓ OpenClaw running at localhost:18789 (v2.1.0)

  Credentials:
    ✓ GITHUB_TOKEN — valid (user: @alice, scopes: repo, read:org)
    ✗ LINEAR_API_KEY — not set
      → Linear personal API key
      → https://linear.app/settings/api

  Hooks:
    ✓ Claude Code stop hook — installed (global)

  Config:
    ✓ orgloop.yaml — valid
    ✓ 3 routes, 2 sources, 1 actor — all references resolve

  1 package missing, 1 credential missing.
  System will run in degraded mode (actor in queue mode).
```

Comprehensive environment validation. Checks packages, services, credentials, hooks, and config validity. Uses connector-provided `ServiceDetector` and `CredentialValidator` when available (see [7.4 Connector Setup Metadata](./plugin-system/)).

```bash
# Machine-readable output (for external tools like orgctl)
$ orgloop doctor --json
{
  "status": "degraded",
  "checks": [
    { "category": "package", "name": "@orgloop/connector-github", "status": "ok", "version": "1.2.0" },
    { "category": "service", "name": "openclaw", "status": "ok", "version": "2.1.0" },
    { "category": "credential", "name": "GITHUB_TOKEN", "status": "ok", "identity": "@alice" },
    { "category": "credential", "name": "LINEAR_API_KEY", "status": "missing",
      "help_url": "https://linear.app/settings/api" }
  ]
}
```

The `--json` output is a stable interface consumed by external orchestration tools (see [Scope Boundaries](./scope-boundaries/) and [orgctl RFP](https://orgloop.ai/vision/orgctl/)).

#### `orgloop add`

```bash
# Add a connector
$ orgloop add connector jira
$ orgloop add connector my-custom --type source

# Add a transform
$ orgloop add transform my-filter --type script
$ orgloop add transform my-enricher --type package

# Add a logger
$ orgloop add logger datadog

# Add a route
$ orgloop add route my-route --source github --actor openclaw-engineering-agent
```

#### `orgloop routes`

```bash
$ orgloop routes

OrgLoop Routes — my-org

  github ──▶ github-pr-review ──▶ openclaw-engineering-agent
                └─ filter: resource.changed, provenance.platform_event: pull_request.review_submitted
                └─ transform: drop-bot-noise → dedup

  linear ──▶ linear-to-engineering ──▶ openclaw-engineering-agent
                └─ filter: resource.changed
                └─ transform: dedup

  claude-code ──▶ claude-code-supervisor ──▶ openclaw-engineering-agent
                └─ filter: actor.stopped

5 routes, 0 warnings
```

Visualizes the routing topology as an ASCII graph. Shows sources, routes (with filter criteria and transform chains), and target actors. Highlights unrouted sources and unreachable actors as warnings.

```bash
# Machine-readable output
$ orgloop routes --json
```

#### `orgloop hook`

```bash
# Forward Claude Code stop hook event to running engine
$ orgloop hook claude-code-stop --port 4800
```

Reads hook event data from stdin and POSTs it to the running OrgLoop engine's webhook endpoint (`POST /webhook/:sourceId`). This is a stdin-to-HTTP bridge — the connector's webhook handler builds the OrgLoopEvent from the raw payload.

Used by external tools (e.g., Claude Code Stop hooks) to forward events into the OrgLoop pipeline. The engine must be running with a webhook-based source registered.

#### `orgloop install-service`

```bash
# Auto-detect platform and generate service file
$ orgloop install-service

Detected platform: macOS (launchd)
Generated: ~/Library/LaunchAgents/com.orgloop.daemon.plist
  KeepAlive: true
  WorkingDirectory: ~/.orgloop
  Config: ~/.orgloop/orgloop.yaml

To activate:
  launchctl load ~/Library/LaunchAgents/com.orgloop.daemon.plist

To deactivate:
  launchctl unload ~/Library/LaunchAgents/com.orgloop.daemon.plist

# Explicit platform
$ orgloop install-service --systemd    # Linux: generates ~/.config/systemd/user/orgloop.service
$ orgloop install-service --launchd    # macOS: generates LaunchAgent plist
$ orgloop install-service --docker     # Generates Dockerfile + docker-compose.yaml

# Service lifecycle (thin wrappers around platform tools)
$ orgloop service start
$ orgloop service stop
$ orgloop service status
$ orgloop service logs
```

The generated service file keeps OrgLoop alive across reboots and restarts on crash. This single service replaces all per-source pollers (e.g., `com.openclaw.github-activity.plist`, `com.openclaw.linear-activity.plist`).

#### `orgloop inspect`

```bash
# Inspect a source
$ orgloop inspect source github
Name:       github
Type:       poll (every 5m)
Connector:  @orgloop/connector-github
Config:     repo=my-org/my-repo, authors=[app/my-ci-bot, alice]
Emits:      resource.changed
Checkpoint: 2026-02-08T20:47:00Z
Routes:     github-to-engineering
Events:     47 (24h), 312 (7d)

# Inspect a route
$ orgloop inspect route github-pr-review
Name:       github-pr-review
Source:     github → [drop-bot-noise, dedup] → openclaw-engineering-agent
Prompt:     ./sops/pr-review.md
Matched:    45 (24h)
Dropped:    2 (24h) — all by drop-bot-noise
Errors:     0
Last event: 3 min ago (evt_abc123)
```

### 8.3 CLI Framework

**Library:** [Commander.js](https://github.com/tj/commander.js/) (mature, well-documented, TypeScript support).

**Output formatting:** Custom output module supporting:
- Human-readable (default): colored, tabular, with emoji indicators
- JSON (`--json`): machine-parseable for scripting
- Quiet (`--quiet`): errors only

**Configuration resolution:**
1. CLI flags (highest priority)
2. Environment variables (`ORGLOOP_*`)
3. `orgloop.yaml` in current directory
4. `~/.orgloop/config.yaml` (user defaults)
