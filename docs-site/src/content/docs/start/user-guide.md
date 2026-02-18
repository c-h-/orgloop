---
title: User Guide
description: Install OrgLoop, configure your environment, and operate OrgLoop day-to-day.
---

A hands-on guide to setting up and running OrgLoop. This covers everything from installation through day-to-day operations. If you haven't read it yet, [What is OrgLoop?](/start/what-is-orgloop/) provides the conceptual foundation.

## 1. Install OrgLoop

**Prerequisites:** Node.js >= 22.

```bash
npm install -g @orgloop/cli
```

Verify:

```bash
orgloop version
```

## 2. Initialize a project

`orgloop init` scaffolds a project with connector configs, directories, and a `.env.example`.

**Interactive mode** (asks you questions):

```bash
mkdir my-org && cd my-org
orgloop init
```

```
? Project name: my-org
? Description: Engineering organization event routing
? Which connectors? github, linear, openclaw, claude-code
```

**Non-interactive mode** (for scripts, CI):

```bash
orgloop init --name my-org --connectors github,linear,openclaw,claude-code --no-interactive
```

This creates:

```
my-org/
  orgloop.yaml              # Project manifest
  connectors/
    github.yaml             # GitHub source config
    linear.yaml             # Linear source config
    openclaw.yaml           # OpenClaw actor config
    claude-code.yaml        # Claude Code source config
  routes/
    example.yaml            # Example route (customize this)
  transforms/
    transforms.yaml         # Transform definitions
    drop-bot-noise.sh       # Example transform script
  loggers/
    default.yaml            # File logger
  sops/
    example.md              # Example launch prompt
  .env.example              # Required environment variables
  .gitignore
```

If you selected `claude-code` as a connector, init also offers to install the Claude Code Stop hook into your `~/.claude/settings.json`.

The CLI tells you what to do next:

```
Next: run `npm install` to install dependencies, then `orgloop doctor` to check your environment.
```

## 3. Install dependencies

After scaffolding, install the `@orgloop/*` packages listed in `package.json`:

```bash
npm install
```

This installs connector, transform, and logger packages into `node_modules/`. The CLI resolves plugins from this directory at runtime.

## 4. Configure your environment

OrgLoop configs reference secrets via `${VAR_NAME}` syntax. The actual values come from environment variables.

### Check what you need

```bash
orgloop env
```

```
Environment Variables:

  ✗ GITHUB_REPO              connectors/github.yaml
    → Repository in owner/repo format
    → https://github.com/settings/tokens
  ✗ GITHUB_TOKEN             connectors/github.yaml
    → GitHub personal access token (repo scope)
    → https://github.com/settings/tokens/new?scopes=repo,read:org
  ✗ LINEAR_TEAM_KEY          connectors/linear.yaml
  ✗ LINEAR_API_KEY           connectors/linear.yaml
    → Linear API key
  ✗ OPENCLAW_WEBHOOK_TOKEN   connectors/openclaw.yaml
    → OpenClaw webhook authentication token

0 of 5 variables set. 5 missing.
Fix missing variables, then run `orgloop validate`.
```

Each missing variable shows:

- Which YAML file requires it
- A description of what the value is
- A URL where you can create the credential (when available)

### Set your variables

```bash
export GITHUB_REPO="my-org/my-repo"
export GITHUB_TOKEN="ghp_..."
export LINEAR_TEAM_KEY="ENG"
export LINEAR_API_KEY="lin_api_..."
export OPENCLAW_WEBHOOK_TOKEN="..."
```

Or use a `.env` file (copy from the generated `.env.example`).

## 5. Health check

```bash
orgloop doctor
```

```
OrgLoop Doctor — my-org

  Credentials
    ✓ GITHUB_REPO
    ✓ GITHUB_TOKEN — valid (user: @alice, scopes: repo, read:org)
    ✓ LINEAR_API_KEY
    ✓ OPENCLAW_WEBHOOK_TOKEN

  Services
    ✓ openclaw — running at http://127.0.0.1:18789

  Config
    ✓ orgloop.yaml — valid project manifest
    ✓ connectors/github.yaml — valid source definition
    ✓ connectors/linear.yaml — valid source definition
    ✓ connectors/openclaw.yaml — valid actor definition

  Route Graph
    (no warnings)

All checks passed.
Next: run `orgloop start` to start.
```

Doctor goes beyond `env` -- it validates credentials against live APIs (when connectors provide validators), detects running services, validates config syntax, and checks route graph integrity.

For CI/automation: `orgloop doctor --json` returns machine-readable output.

## 6. Validate config

```bash
orgloop validate
```

```
  ✓ orgloop.yaml                  valid project manifest
  ✓ connectors/github.yaml        valid source definition
  ✓ connectors/linear.yaml        valid source definition
  ✓ connectors/openclaw.yaml      valid actor definition
  ✓ connectors/claude-code.yaml   valid source definition
  ✓ transforms/transforms.yaml    valid transform group
  ✓ transform: drop-bot-noise     valid script transform
  ✓ loggers/default.yaml          valid logger group
0 errors, 0 warnings ✓
Next: run `orgloop doctor` for a full health check.
```

Validate checks:

- YAML syntax
- Schema conformance (`apiVersion`, `kind`, required fields)
- Reference integrity (routes reference existing sources, actors, transforms)
- Transform script existence and permissions
- Route graph warnings (dead sources, unreachable actors, orphan transforms)
- Missing environment variables

## 7. Preview changes

```bash
orgloop plan
```

```
OrgLoop Plan — my-org

  Sources:
    + github                  (new — poll every 5m)
    + linear                  (new — poll every 5m)
    + claude-code             (new — hook)

  Actors:
    + openclaw-engineering-agent  (new)

  Routes:
    + github-pr-review        (new)
    + github-pr-comment       (new)
    + github-ci-failure       (new)
    + claude-code-to-supervisor  (new)
    + linear-to-engineering   (new)

  Transforms:
    + drop-bot-noise          (new — script)

  Loggers:
    + file-log                (new)

Plan: 12 to add, 0 to change, 0 to remove.

Run `orgloop start` to execute this plan.
```

Plan compares your YAML config against the last running state (stored in `~/.orgloop/state.json`). On first run, everything shows as `+ new`. After changes, you see `~ changed` and `- removed`.

Symbols: `+` new, `~` changed, `=` unchanged, `-` removed.

## 8. Visualize routes

```bash
orgloop routes
```

```
OrgLoop Routes — my-org

  github ──▶ github-pr-review ──▶ openclaw-engineering-agent
                └─ filter: resource.changed
                └─ transform: drop-bot-noise

  github ──▶ github-ci-failure ──▶ openclaw-engineering-agent
                └─ filter: resource.changed
                └─ transform: drop-bot-noise

  linear ──▶ linear-to-engineering ──▶ openclaw-engineering-agent
                └─ filter: resource.changed

  claude-code ──▶ claude-code-to-supervisor ──▶ openclaw-engineering-agent
                └─ filter: actor.stopped

4 routes, 0 warnings
```

For machine-readable output: `orgloop routes --json`.

## 9. Start the engine

```bash
orgloop start
```

```
Applying plan...

Source github — polling started (every 5m)
Source linear — polling started (every 5m)
Source claude-code — hook listener started
Actor openclaw-engineering-agent — ready
Route github-pr-review — active
Route github-ci-failure — active
Route linear-to-engineering — active
Route claude-code-to-supervisor — active
Logger file-log — configured

OrgLoop is running. PID: 42831
Logs: orgloop logs | Status: orgloop status | Stop: orgloop stop
```

What happens when start runs:

1. Loads and validates config
2. Checks all environment variables (fails fast if any are missing)
3. Resolves connector packages (`@orgloop/connector-github`, etc.)
4. Initializes sources, actors, transforms, loggers
5. Starts the scheduler (poll-based sources poll on their interval)
6. Starts the webhook server (for hook-based sources like Claude Code)
7. Writes PID and state files to `~/.orgloop/`
8. Runs in foreground (Ctrl+C to stop)

### Background mode

```bash
orgloop start --daemon
```

Forks to background and writes PID to `~/.orgloop/orgloop.pid`.

### Supervised daemon mode

```bash
orgloop start --daemon --supervised
```

Runs as a daemon with an auto-restart supervisor. If the OrgLoop process crashes, the supervisor automatically restarts it. Recommended for production deployments.

### Pre-flight failures

If env vars are missing, start shows which ones and exits before starting anything:

```
Environment Variables:

  ✓ GITHUB_REPO
  ✗ GITHUB_TOKEN             connectors/github.yaml
    → GitHub personal access token (repo scope)
    → https://github.com/settings/tokens/new?scopes=repo,read:org

1 variable missing — run `orgloop env` for details.
```

## 10. Day-to-day operations

### Check status

```bash
orgloop status
```

```
OrgLoop — my-org (running, PID 42831)

  NAME            TYPE    INTERVAL
  github          poll    5m
  linear          poll    5m
  claude-code     hook    —

  NAME                          STATUS
  openclaw-engineering-agent    healthy

  NAME                         SOURCE         ACTOR
  github-pr-review             github         openclaw-engineering-agent
  github-ci-failure            github         openclaw-engineering-agent
  linear-to-engineering        linear         openclaw-engineering-agent

Recent Events (last 5):
  TIME      SOURCE    TYPE                  ROUTE                    STATUS
  14:32:01  github    resource.changed      github-pr-review         success
  14:31:55  github    resource.changed      github-ci-failure        success
  14:27:12  linear    resource.changed      linear-to-engineering    success
```

If OrgLoop is not running:

```
OrgLoop is not running.
Run `orgloop start` to start.
```

### View logs

**Tail logs** (follows new entries):

```bash
orgloop logs
```

**Filter logs:**

```bash
orgloop logs --source github              # Only GitHub events
orgloop logs --route github-pr-review     # Only this route
orgloop logs --result drop                # Only dropped events
orgloop logs --since 2h                   # Last 2 hours
orgloop logs --event evt_abc123           # Trace a specific event
```

**Query mode** (don't follow, just print matches):

```bash
orgloop logs --no-follow --source linear --since 1h
```

**JSON output:**

```bash
orgloop logs --json --no-follow
```

### Test with synthetic events

Generate a sample event for a connector:

```bash
orgloop test --generate github
```

This prints a realistic event JSON to stdout. Pipe it back to test the pipeline:

```bash
orgloop test --generate github | orgloop test -
```

```
Injecting test event: resource.changed (source: github)

Transform: drop-bot-noise — PASS (2ms)
Route match: github-pr-review
Delivery: openclaw-engineering-agent — OK (simulated)

Event evt_abc1234567890 traced successfully through 1 route.
```

Test from a file:

```bash
orgloop test event.json
```

Dry run (trace path without delivering):

```bash
orgloop test event.json --dry-run
```

### Stop the engine

```bash
orgloop stop
```

Or press Ctrl+C if running in foreground.

## 11. When OrgLoop stops

When OrgLoop stops (Ctrl+C, `orgloop stop`, process killed):

- **All polling stops.** Sources stop fetching new events.
- **No new events are processed.** Events that arrived but weren't yet processed are lost (no durable queue by default).
- **Actors are not notified.** Running actor sessions continue independently -- they don't know OrgLoop stopped.
- **State is preserved.** The last config state remains in `~/.orgloop/state.json`. Source checkpoints remain in `~/.orgloop/checkpoints/`. Logs remain in `~/.orgloop/logs/`.

To restart:

```bash
orgloop start
```

Plan will show `= unchanged` for existing components and pick up where it left off (sources resume from their last checkpoint).

## 12. Customizing

### Add a new connector

```bash
orgloop add connector my-source --type source
orgloop add connector my-target --type actor
```

Creates a YAML file in `connectors/` and adds it to `orgloop.yaml`.

### Add a new route

```bash
orgloop add route pr-to-slack --source github --actor slack-notify
```

Creates a YAML file in `routes/`.

### Add a transform

Script-based (bash, any language):

```bash
orgloop add transform my-filter --type script
```

Creates a bash script in `transforms/` and a YAML definition. Exit code 0 = pass the event, exit code 78 = drop it.

Package-based (TypeScript):

```bash
orgloop add transform my-enricher --type package
```

Creates a TypeScript package transform for more complex logic.

### Add a logger

```bash
orgloop add logger audit-log
```

Creates a logger YAML in `loggers/`.

### Manual editing

You can always edit YAML files directly. The structure is:

| Directory | Contents |
|-----------|----------|
| `orgloop.yaml` | Project manifest, references all other files |
| `connectors/*.yaml` | Source and actor definitions |
| `routes/*.yaml` | Routing rules |
| `transforms/*.yaml` | Transform definitions (+ scripts) |
| `loggers/*.yaml` | Logger definitions |
| `sops/*.md` | Launch prompts referenced by routes |

After editing, run `orgloop validate` to check your work.

## 13. CLI quick reference

| Command | Description |
|---------|-------------|
| `orgloop init` | Scaffold a new project |
| `orgloop add connector <name>` | Add a new connector |
| `orgloop add route <name>` | Add a new route |
| `orgloop add transform <name>` | Add a new transform |
| `orgloop add logger <name>` | Add a new logger |
| `orgloop env` | Check environment variables |
| `orgloop env check` | Check env vars (exit 1 if missing) |
| `orgloop doctor` | Full environment health check |
| `orgloop validate` | Validate config files |
| `orgloop plan` | Show what would change (dry run) |
| `orgloop routes` | Visualize routing topology |
| `orgloop start` | Start the runtime |
| `orgloop start --daemon` | Start as background daemon |
| `orgloop start --daemon --supervised` | Start as supervised daemon (auto-restart) |
| `orgloop status` | Show runtime status |
| `orgloop logs` | Tail the event log |
| `orgloop test [file]` | Inject a test event |
| `orgloop test --generate <connector>` | Generate a sample event |
| `orgloop stop` | Stop the runtime gracefully |
| `orgloop hook claude-code-stop` | Forward Claude Code stop hook |

**Global options:**

| Option | Description |
|--------|-------------|
| `--config <path>` | Path to orgloop.yaml (default: `./orgloop.yaml`) |
| `--json` | Machine-readable JSON output |
| `--no-interactive` | Disable interactive prompts |

For the full reference, see [CLI Command Reference](/cli/command-reference/).

## Next steps

- [Five Primitives](/concepts/five-primitives/) -- understand Sources, Actors, Routes, Transforms, Loggers in depth
- [Event Taxonomy](/concepts/event-taxonomy/) -- the three event types and how they compose
- [Engineering Org example](/examples/engineering-org/) -- full production setup walkthrough
- [Building Connectors](/guides/connector-authoring/) -- create your own source or target connector
- [Project Setup](/guides/project-setup/) -- create and configure an OrgLoop project
