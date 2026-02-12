---
title: Command Reference
description: Complete reference for all OrgLoop CLI commands.
---

Install:

```bash
npm install -g @orgloop/cli
```

## Commands Overview

| Command | Description |
|---------|-------------|
| [`orgloop init`](#init) | Scaffold a new project |
| [`orgloop add`](#add) | Add connectors, transforms, loggers, routes, or modules |
| [`orgloop validate`](#validate) | Validate configuration files and references |
| [`orgloop env`](#env) | Check environment variable configuration |
| [`orgloop doctor`](#doctor) | Full environment health check |
| [`orgloop plan`](#plan) | Preview changes (Terraform-style diff) |
| [`orgloop routes`](#routes) | Visualize the routing topology |
| [`orgloop start`](#start) | Start the runtime |
| [`orgloop status`](#status) | Show runtime status and recent events |
| [`orgloop module`](#module) | Manage runtime modules (list, status, load, unload, reload) |
| [`orgloop logs`](#logs) | Tail or query the event log |
| [`orgloop test`](#test) | Inject a test event and trace its path |
| [`orgloop stop`](#stop) | Stop the runtime gracefully |
| [`orgloop hook`](#hook) | Forward hook events to the running engine |
| [`orgloop inspect`](#inspect) | Deep-dive into a source, actor, or route |
| [`orgloop install-service`](#install-service) | Generate a platform service file |
| [`orgloop service`](#service) | Manage the installed service |
| [`orgloop version`](#version) | Print version info |

## Global Flags

Available on all commands:

| Flag | Short | Description |
|------|-------|-------------|
| `--config <path>` | `-c` | Path to orgloop.yaml (default: `./orgloop.yaml`) |
| `--json` | | Machine-readable JSON output |
| `--no-interactive` | | Disable interactive prompts |
| `--verbose` | `-v` | Verbose output |
| `--help` | `-h` | Show help |

### Configuration Resolution Order

1. CLI flags (highest priority)
2. Environment variables (`ORGLOOP_*`)
3. `orgloop.yaml` in current directory
4. `~/.orgloop/config.yaml` (user defaults)

---

## init

Scaffold a new OrgLoop project.

```
orgloop init [options]
```

| Flag | Description |
|------|-------------|
| `--name <name>` | Project name |
| `--connectors <list>` | Comma-separated connector names (e.g., `github,linear,openclaw`) |
| `--no-interactive` | Skip all prompts, use defaults and flags |

### Interactive mode

```bash
$ orgloop init

? Project name: my-org
? Description: Engineering organization event routing
? Which connectors? (space to select)
  * GitHub
  * Linear
  * OpenClaw
  * Claude Code
    Webhook (generic)

Created:
  orgloop.yaml
  connectors/github.yaml
  connectors/linear.yaml
  connectors/openclaw.yaml
  connectors/claude-code.yaml
  routes/example.yaml
  loggers/default.yaml
  transforms/transforms.yaml
  sops/example.md

Next: run `orgloop add module <name>` to install a workflow, or `orgloop doctor` to check your environment.
```

If Claude Code is selected, `init` offers to install the OrgLoop stop hook into your Claude Code settings (global or project scope).

### Non-interactive mode

```bash
orgloop init --name my-org --connectors github,linear,openclaw --no-interactive
```

---

## add

Scaffold new components or install workflow modules.

### add connector

```
orgloop add connector <name> [options]
```

| Flag | Description |
|------|-------------|
| `--type <source\|actor>` | Connector type |

```bash
orgloop add connector jira
orgloop add connector my-custom --type source
```

### add transform

```
orgloop add transform <name> [options]
```

| Flag | Description |
|------|-------------|
| `--type <script\|package>` | Transform type |

```bash
orgloop add transform my-filter --type script     # Creates a bash script
orgloop add transform my-enricher --type package   # Creates a TypeScript package
```

Script transforms: exit code 0 = pass, exit code 78 = drop.

### add logger

```
orgloop add logger <name>
```

```bash
orgloop add logger datadog
```

### add route

```
orgloop add route <name> [options]
```

| Flag | Description |
|------|-------------|
| `--source <id>` | Source connector ID |
| `--actor <id>` | Actor connector ID |

```bash
orgloop add route my-route --source github --actor engineering
```

### add module

Install a composable workflow module.

```
orgloop add module <name> [options]
```

| Flag | Description |
|------|-------------|
| `--path <dir>` | Install from a local directory |
| `--no-interactive` | Skip parameter prompts, use defaults |
| `--params <json>` | Parameter values as JSON string |

```bash
# Install from npm registry
orgloop add module engineering

# Install from a local path
orgloop add module my-workflow --path ./modules/my-workflow

# Non-interactive with explicit params
orgloop add module engineering --no-interactive \
  --params '{"github_source":"github","agent_actor":"engineering"}'
```

See [Modules](/concepts/modules/) for details on the module system.

---

## validate

Validate configuration files and all references.

```
orgloop validate
```

```bash
$ orgloop validate

  ✓ orgloop.yaml                  valid project manifest
  ✓ connectors/github.yaml        valid source definition
  ✓ connectors/openclaw.yaml      valid actor definition
  ✗ routes/engineering.yaml — error at routes[0].transforms[1]:
      Transform "injection-scanner" not found. Did you mean "injection-scan"?
  ✓ loggers/default.yaml          valid logger group

1 error, 0 warnings
```

What gets validated:

- YAML syntax
- Schema conformance (JSON Schema via AJV)
- Reference integrity -- routes reference existing sources, actors, transforms
- Connector config completeness (required fields present)
- Transform script existence and permissions (executable bit)
- Launch prompt file existence (routes with `with.prompt_file`)
- Module manifest validation and route expansion
- Environment variable references

---

## env

Check environment variable configuration. Scans all YAML files for `${VAR_NAME}` references and shows which are set and which are missing.

```
orgloop env [check] [options]
```

```bash
$ orgloop env

Environment Variables:

  ✓ GITHUB_TOKEN             connectors/github.yaml
  ✗ LINEAR_API_KEY           connectors/linear.yaml
    → Linear personal API key
    → https://linear.app/settings/api
  ✓ OPENCLAW_WEBHOOK_TOKEN   connectors/openclaw.yaml

2 of 3 variables set. 1 missing.
```

When connector setup metadata is available, missing variables show a description and a help URL for creating the credential.

### env check

Strict mode for CI. Exits with code 1 if any required variable is missing.

```bash
orgloop env check
```

### Machine-readable output

```bash
orgloop env --json
```

---

## doctor

Comprehensive environment health check. Goes beyond `env` to validate credentials against live APIs, detect running services, check config validity, and verify the route graph.

```
orgloop doctor [options]
```

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable JSON output (stable interface for external tools) |

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
  System will run in degraded mode.
```

### JSON output

```bash
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

---

## plan

Preview what will change before starting the runtime. Terraform-style diff.

```
orgloop plan
```

```bash
$ orgloop plan

OrgLoop Plan — my-org

  Sources:
    + github          (new — poll every 5m)
    + linear          (new — poll every 5m)
    ~ claude-code     (changed — hook_type: post-exit → exit)

  Actors:
    = engineering     (unchanged)

  Routes:
    + github-pr-review          (new)
    + github-ci-failure         (new)
    + linear-to-engineering     (new)
    + claude-code-to-supervisor (new)

  Transforms:
    + drop-bot-noise            (new — package)

  Loggers:
    = file-log                  (unchanged)
    + console-log               (new)

Plan: 7 to add, 1 to change, 0 to remove.

Run `orgloop start` to execute this plan.
```

Symbols:

| Symbol | Meaning |
|--------|---------|
| `+` | New -- will be created |
| `~` | Changed -- will be updated |
| `=` | Unchanged -- already running |
| `-` | Removed -- will be stopped |

Plan compares your YAML config against the last running state (stored in `~/.orgloop/state.json`). On first run, everything shows as `+ new`.

---

## routes

Visualize the routing topology as an ASCII graph.

```
orgloop routes [options]
```

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable JSON output |

```bash
$ orgloop routes

OrgLoop Routes — my-org

  github ──▶ github-pr-review ──▶ engineering
                └─ filter: resource.changed, provenance.platform_event: pull_request.review_submitted
                └─ transform: drop-bot-noise → dedup

  linear ──▶ linear-to-engineering ──▶ engineering
                └─ filter: resource.changed
                └─ transform: dedup

  claude-code ──▶ claude-code-supervisor ──▶ engineering
                └─ filter: actor.stopped

5 routes, 0 warnings
```

Shows sources, routes with filter criteria and transform chains, and target actors. Highlights unrouted sources and unreachable actors as warnings.

---

## start

Start the runtime. Events begin flowing.

Internally, `start` creates a Runtime instance, loads your config as a module, and starts an HTTP control API. The control API port is written to `~/.orgloop/runtime.port` so that other commands (`status`, `stop`, `module`) can communicate with the running runtime.

```
orgloop start [options]
```

| Flag | Description |
|------|-------------|
| `--daemon` | Run as background daemon |
| `--force` | Skip doctor pre-flight checks |

### Foreground (development)

```bash
$ orgloop start

  ✓ Source github — polling started (every 5m)
  ✓ Source linear — polling started (every 5m)
  ✓ Source claude-code — hook listener started
  ✓ Actor engineering — ready
  ✓ Route github-pr-review — active
  ✓ Route linear-to-engineering — active
  ✓ Route claude-code-to-supervisor — active
  ✓ Logger file-log — configured
  ✓ Logger console-log — configured

OrgLoop is running. PID: 42891
Logs: orgloop logs | Status: orgloop status | Stop: orgloop stop
```

Press Ctrl+C to stop in foreground mode.

### Daemon mode (production)

```bash
orgloop start --daemon
# PID written to ~/.orgloop/orgloop.pid
# Control API port written to ~/.orgloop/runtime.port
```

One long-running process manages all source polling internally. Poll intervals are declared in YAML -- no external schedulers, no separate LaunchAgents, no cron jobs.

Once the runtime is running, use `orgloop module list` to see loaded modules and `orgloop module load` to hot-load additional modules without restarting.

### Pre-flight validation

Start checks environment variables before starting. If any are missing, it fails fast with actionable guidance:

```
Environment Variables:

  ✓ GITHUB_REPO
  ✗ GITHUB_TOKEN             connectors/github.yaml
    → GitHub personal access token (repo scope)
    → https://github.com/settings/tokens/new?scopes=repo,read:org

1 variable missing — run `orgloop env` for details.
```

---

## status

Show runtime status and recent events. Queries the running runtime's control API (`GET /control/status`) for module-aware status. Falls back to PID-based status if the control API is not reachable.

```
orgloop status [options]
```

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable JSON output |

```bash
$ orgloop status

OrgLoop Runtime
  Status: running (PID 42891)
  Uptime: 3h 22m
  Control API: http://127.0.0.1:9801
  Modules: 1

Module: my-org
  State: running | Uptime: 3h 22m
  Sources: 3 | Actors: 1 | Routes: 4

  SOURCE           TYPE      HEALTH
  github           poll      healthy
  linear           poll      healthy
  claude-code      hook      —

Recent Events (last 5):
  TIME          SOURCE    TYPE              ROUTE                      STATUS
  20:47:12      github    resource.changed  github-pr-review           delivered
  20:47:12      github    resource.changed  github-pr-review           dropped (bot)
  20:42:08      linear    resource.changed  linear-to-engineering      delivered
  20:18:33      cc        actor.stopped     claude-code-to-supervisor  delivered
  20:15:01      github    resource.changed  github-pr-review           delivered
```

When multiple modules are loaded, each module is displayed as its own section with independent health tables. Use `orgloop module status <name>` for a detailed view of a single module.

---

## module

Manage modules in a running runtime. All subcommands communicate with the runtime via its HTTP control API (port read from `~/.orgloop/runtime.port`). The runtime must be running (`orgloop start`) before using these commands.

### module list

List all loaded modules.

```
orgloop module list
```

```bash
$ orgloop module list

Modules
  NAME                      STATE         SOURCES     ROUTES      ACTORS      UPTIME
  my-org                    running       3           4           1           3h 22m
  monitoring                running       1           2           1           1h 05m
```

### module status

Show detailed status for a loaded module, including per-source health.

```
orgloop module status <name>
```

```bash
$ orgloop module status my-org

Module: my-org
  State:  running
  Uptime: 3h 22m

  SOURCE                    TYPE      HEALTH
  github                    poll      healthy
  linear                    poll      healthy
  claude-code               hook      —

  Routes: 4
```

### module load

Load a module into the running runtime. The module is resolved, validated, and started without restarting the runtime.

```
orgloop module load <path> [options]
```

| Flag | Description |
|------|-------------|
| `--params <json>` | Module parameters as JSON string |
| `--params-file <path>` | Path to JSON file with module parameters |

```bash
# Load a local module
orgloop module load ./modules/monitoring

# Load with parameters
orgloop module load ./modules/engineering \
  --params '{"github_source":"github","agent_actor":"engineering"}'

# Load with parameters from a file
orgloop module load ./modules/engineering --params-file params.json
```

### module unload

Unload a module from the running runtime. Stops all sources, routes, and actors owned by the module.

```
orgloop module unload <name>
```

```bash
$ orgloop module unload monitoring
  ✓ Module monitoring unloaded.
```

### module reload

Reload a module (unload + load). Useful after changing module configuration or code.

```
orgloop module reload <name>
```

```bash
$ orgloop module reload my-org
  ✓ Module my-org reloaded.
```

---

## logs

Tail or query the event log.

```
orgloop logs [options]
```

| Flag | Description |
|------|-------------|
| `--source <id>` | Filter by source connector ID |
| `--route <name>` | Filter by route name |
| `--result <result>` | Filter by result (`drop`, `deliver`, `error`) |
| `--since <duration>` | Time window (e.g., `2h`, `30m`, `1d`) |
| `--event <id>` | Trace a specific event by ID |
| `--json` | JSON output |
| `--no-follow` | Do not tail (print matches and exit) |

### Examples

```bash
# Tail all logs (follows new entries)
orgloop logs

# Filter by source
orgloop logs --source github

# Filter by route
orgloop logs --route github-pr-review

# Historical query (last 2 hours, resource.changed only)
orgloop logs --since 2h --source github

# Show only dropped events
orgloop logs --result drop

# Trace a specific event end-to-end
orgloop logs --event evt_abc123

# Query mode (do not follow, just print)
orgloop logs --no-follow --source linear --since 1h

# Machine-readable output
orgloop logs --json --no-follow
```

Log entries capture every phase of the pipeline:

```jsonl
{"ts":"...","phase":"source","source":"github","event_id":"evt_abc","event_type":"resource.changed"}
{"ts":"...","phase":"transform","transform":"drop-bot-noise","event_id":"evt_abc","result":"pass"}
{"ts":"...","phase":"route","event_id":"evt_abc","matched":"github-pr-review"}
{"ts":"...","phase":"deliver","event_id":"evt_abc","target":"engineering","status":"delivered"}
```

---

## test

Inject a test event and trace its path through the pipeline.

```
orgloop test [file] [options]
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Trace the event path without actual delivery |
| `--generate <connector>` | Generate a sample event for a connector |
| `-` | Read event from stdin |

### Inject from a file

```bash
$ orgloop test event.json

Injecting test event: resource.changed (source: github)

  ✓ Transform: drop-bot-noise — PASS (2ms)
  ✓ Transform: injection-scanner — PASS (15ms)
  ✓ Route match: github-pr-review
  ✓ Delivery: engineering — 200 OK (89ms)

Event evt_test_001 traced successfully through 1 route.
```

### Dry run

```bash
orgloop test event.json --dry-run
```

Traces the event through transforms and route matching without delivering to actors.

### Generate a sample event

```bash
# Generate and print a sample event for a connector
orgloop test --generate github

# Generate and immediately test the pipeline
orgloop test --generate github | orgloop test -
```

### Inject from stdin

```bash
echo '{"type":"resource.changed","source":"github","payload":{}}' | orgloop test -
```

---

## stop

Stop the runtime gracefully. Tries the control API first (`POST /control/shutdown`) for a clean shutdown of all modules and the HTTP server. Falls back to `SIGTERM` via PID file if the control API is not reachable.

```
orgloop stop [options]
```

| Flag | Description |
|------|-------------|
| `--force` | Force kill with SIGKILL |

```bash
$ orgloop stop

Stopping OrgLoop (PID 42891)...
Requesting graceful shutdown via control API...
  ✓ Stopped.
```

Graceful shutdown: flushes log buffers, persists source checkpoints, waits for in-flight deliveries (with timeout), then exits. If the process does not exit within 10 seconds, it is force-killed with `SIGKILL`.

---

## hook

Forward hook events from external tools to the running OrgLoop engine.

```
orgloop hook <hook-type> [options]
```

### claude-code-stop

Forward a Claude Code stop hook event.

```bash
orgloop hook claude-code-stop
```

Reads hook event data from stdin and POSTs it to the running engine's webhook endpoint. Used by Claude Code's post-exit hooks to forward session completion events into OrgLoop's pipeline.

The engine must be running with a `claude-code` source registered.

---

## inspect

Deep-dive into a specific source, actor, or route.

```
orgloop inspect <type> <name>
```

### Inspect a source

```bash
$ orgloop inspect source github

Name:       github
Type:       poll (every 5m)
Connector:  @orgloop/connector-github
Config:     repo=my-org/my-repo
Emits:      resource.changed
Checkpoint: 2026-02-08T20:47:00Z
Routes:     github-pr-review, github-ci-failure
Events:     47 (24h), 312 (7d)
```

### Inspect a route

```bash
$ orgloop inspect route github-pr-review

Name:       github-pr-review
Source:     github → [drop-bot-noise, injection-scanner] → engineering
Prompt:     ./sops/pr-review.md
Matched:    45 (24h)
Dropped:    2 (24h) — all by drop-bot-noise
Errors:     0
Last event: 3 min ago (evt_abc123)
```

Shows configuration, event statistics, connected components, and recent activity.

---

## install-service

Generate a platform service file to run OrgLoop as a system service.

```
orgloop install-service [options]
```

| Flag | Description |
|------|-------------|
| `--launchd` | macOS LaunchAgent plist |
| `--systemd` | Linux systemd user service |
| `--docker` | Dockerfile + docker-compose.yaml |

### Auto-detect platform

```bash
$ orgloop install-service

Detected platform: macOS (launchd)
Generated: ~/Library/LaunchAgents/com.orgloop.daemon.plist
  KeepAlive: true
  WorkingDirectory: ~/.orgloop
  Config: ~/.orgloop/orgloop.yaml

To activate:
  launchctl load ~/Library/LaunchAgents/com.orgloop.daemon.plist
```

### Explicit platform

```bash
orgloop install-service --systemd    # Linux
orgloop install-service --launchd    # macOS
orgloop install-service --docker     # Docker
```

The generated service keeps OrgLoop alive across reboots and restarts on crash.

---

## service

Manage the installed system service. Thin wrappers around platform tools (launchctl, systemctl).

```
orgloop service <action>
```

| Action | Description |
|--------|-------------|
| `start` | Start the OrgLoop service |
| `stop` | Stop the service |
| `status` | Show service status |
| `logs` | View service logs |

```bash
orgloop service start
orgloop service stop
orgloop service status
orgloop service logs
```

---

## version

Print version information.

```
orgloop version
```

```bash
$ orgloop version
@orgloop/cli 1.0.0
```
