---
title: Project Setup
description: How to create, configure, and manage an OrgLoop project.
---

An OrgLoop project is a standard directory with two key files: `orgloop.yaml` (the project manifest) and `package.json` (npm dependencies). There is no custom module system or proprietary packaging -- OrgLoop projects are package-native, using npm for dependency management and YAML for configuration.

## Scaffolding a new project

The fastest way to start is `orgloop init`:

### Interactive mode (default)

```bash
mkdir my-org && cd my-org
orgloop init
```

The CLI prompts for a project name, description, and which connectors to include. It scaffolds the full directory structure, generates a `package.json` with the correct `@orgloop/*` dependencies, and creates a `.env.example` with the environment variables your chosen connectors require.

### Non-interactive mode

```bash
orgloop init --name my-org --connectors github,linear,openclaw --no-interactive
```

Flags:

| Flag | Description |
|------|-------------|
| `--name <name>` | Project name (default: `my-org`) |
| `--description <desc>` | Project description |
| `--connectors <list>` | Comma-separated connector list (e.g., `github,linear,openclaw,claude-code`) |
| `--no-interactive` | Skip all prompts |
| `--dir <path>` | Target directory (default: current directory) |

After scaffolding, run `npm install` to install dependencies.

## Project directory structure

```
my-org/
  package.json          # npm deps (@orgloop/core, connectors, transforms, loggers)
  orgloop.yaml          # Project manifest (kind: Project)
  connectors/           # Connector YAML files
  routes/               # Route YAML files
  transforms/           # Transform scripts and YAML
  loggers/              # Logger YAML files
  sops/                 # Launch prompt markdown files
  .env.example          # Environment variable template
```

Every subdirectory holds YAML configuration files for that resource type. The `sops/` directory holds Markdown launch prompts that routes reference via `prompt_file`. The `transforms/` directory can also contain shell scripts for script-based transforms.

## Project manifest: orgloop.yaml

The root `orgloop.yaml` declares the project and references all resource files:

```yaml
apiVersion: orgloop/v1alpha1
kind: Project

metadata:
  name: engineering-org
  description: "Engineering organization event routing"

defaults:
  poll_interval: "5m"
  event_retention: "30d"
  log_level: info

connectors:
  - connectors/github.yaml
  - connectors/linear.yaml
  - connectors/openclaw.yaml
  - connectors/claude-code.yaml

routes:
  - routes/engineering.yaml

transforms:
  - transforms/transforms.yaml

loggers:
  - loggers/default.yaml
```

The `connectors`, `routes`, `transforms`, and `loggers` arrays contain **file paths** relative to the project root -- not package names. Each referenced file uses its own `kind` (`ConnectorGroup`, `RouteGroup`, `TransformGroup`, `LoggerGroup`).

## Package dependencies: package.json

OrgLoop projects use npm for dependency management. The `package.json` lists `@orgloop/core` plus whichever connector, transform, and logger packages the project needs:

```json
{
  "private": true,
  "description": "OrgLoop project: engineering-org",
  "dependencies": {
    "@orgloop/connector-claude-code": "^0.1.9",
    "@orgloop/connector-github": "^0.1.9",
    "@orgloop/connector-linear": "^0.1.9",
    "@orgloop/connector-openclaw": "^0.1.9",
    "@orgloop/core": "^0.1.9",
    "@orgloop/logger-file": "^0.1.9",
    "@orgloop/transform-dedup": "^0.1.9",
    "@orgloop/transform-filter": "^0.1.9"
  }
}
```

`orgloop init` generates this file automatically based on the connectors you select. You can add more packages later with `npm install`.

## Adding connectors

Install the connector package, then create a YAML file in `connectors/`:

```bash
npm install @orgloop/connector-github
```

Create `connectors/github.yaml`:

```yaml
apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

sources:
  - id: github
    description: GitHub repository events
    connector: "@orgloop/connector-github"
    config:
      repo: "${GITHUB_REPO}"
      token: "${GITHUB_TOKEN}"
      events:
        - "pull_request.review_submitted"
        - "pull_request_review_comment"
        - "workflow_run.completed"
    poll:
      interval: "5m"
    emits:
      - resource.changed
```

Then add the file path to your `orgloop.yaml` under `connectors:`.

Actor connectors (targets) follow the same pattern but use an `actors:` block instead of `sources:`:

```yaml
apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

actors:
  - id: openclaw-engineering-agent
    description: OpenClaw engineering agent
    connector: "@orgloop/connector-openclaw"
    config:
      base_url: "http://127.0.0.1:18789"
      auth_token_env: "${OPENCLAW_WEBHOOK_TOKEN}"
      agent_id: "${OPENCLAW_AGENT_ID}"
```

Available connectors: `github`, `linear`, `claude-code`, `openclaw`, `webhook`, `slack`, `pagerduty`.

## Adding transforms

Transforms filter and enrich events in the routing pipeline. Two types are supported.

### Package-based transforms

Install the package:

```bash
npm install @orgloop/transform-filter @orgloop/transform-dedup
```

Define them in `transforms/transforms.yaml`:

```yaml
apiVersion: orgloop/v1alpha1
kind: TransformGroup

transforms:
  - name: drop-bot-noise
    type: package
    package: "@orgloop/transform-filter"
    config:
      exclude:
        provenance.author_type: bot

  - name: dedup
    type: package
    package: "@orgloop/transform-dedup"
    config:
      key:
        - source
        - type
        - provenance.platform_event
        - payload.pr_number
      window: 5m
```

### Script-based transforms

Write a shell script that reads event JSON from stdin and writes modified JSON to stdout. Exit code 78 (or empty stdout) drops the event.

Create `transforms/drop-bot-noise.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

EVENT=$(cat)
AUTHOR_TYPE=$(echo "$EVENT" | jq -r '.provenance.author_type // "unknown"')

if [ "$AUTHOR_TYPE" = "bot" ]; then
  exit 78  # DROP
fi

echo "$EVENT"
exit 0
```

Reference it in `transforms/transforms.yaml`:

```yaml
transforms:
  - name: drop-bot-noise
    type: script
    script: ./drop-bot-noise.sh
    timeout_ms: 5000
```

## Adding routes

Routes wire sources to actors. Create YAML files in `routes/`:

```yaml
apiVersion: orgloop/v1alpha1
kind: RouteGroup
metadata:
  name: engineering-routes

routes:
  - name: github-pr-review
    description: "PR review submitted -> Engineering agent"

    when:
      source: github
      events:
        - resource.changed
      filter:
        provenance.platform_event: pull_request.review_submitted

    transforms:
      - ref: drop-bot-noise
      - ref: dedup

    then:
      actor: openclaw-engineering-agent
      config:
        session_key: "hook:github:pr-review:engineering"
        wake_mode: now
        deliver: true

    with:
      prompt_file: ../sops/pr-review.md
```

Key fields:

- **`when.source`** -- the source connector ID to match events from.
- **`when.events`** -- event types to match (`resource.changed`, `actor.stopped`, `message.received`).
- **`when.filter`** -- dot-path conditions on event fields. All must match.
- **`transforms`** -- sequential transform pipeline. Each `ref` names a transform from a `TransformGroup`.
- **`then.actor`** -- the actor connector ID to deliver to.
- **`with.prompt_file`** -- path to a Markdown launch prompt (resolved relative to the route YAML file).

Add the file path to your `orgloop.yaml` under `routes:`.

## Environment variables

Secrets and configuration values use `${VAR_NAME}` substitution in YAML. Never put credentials directly in config files.

```yaml
config:
  token: "${GITHUB_TOKEN}"
  repo: "${GITHUB_REPO}"
```

Check which variables your project needs and whether they are set:

```bash
orgloop env
```

This shows each required variable with a status indicator and setup guidance for any that are missing. Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
# Edit .env with your credentials
```

OrgLoop automatically loads `.env` files from the project root.

## Validating and running

OrgLoop provides a structured workflow for going from configuration to running:

### 1. Health check

```bash
orgloop doctor
```

Runs a full environment health check: config validation, dependency resolution, environment variable status, and service connectivity. Fix any issues it reports before proceeding.

### 2. Validate configuration

```bash
orgloop validate
```

Checks that all YAML is well-formed, all referenced files exist, all connector packages resolve, and all environment variables are defined.

### 3. Preview the execution plan

```bash
orgloop plan
```

Shows what will happen when you start: which sources will poll, which routes are active, which actors will receive events. Review this before starting.

### 4. Start the runtime

```bash
orgloop start
```

Starts the event loop. Sources begin polling, events flow through routes and transforms, and actors receive deliveries.

See the [CLI Command Reference](/cli/command-reference/) for the full list of commands and options.
