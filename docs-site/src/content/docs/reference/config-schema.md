---
title: Config Schema
description: Complete reference for OrgLoop YAML configuration files.
---

OrgLoop uses YAML for all configuration, with JSON Schema for validation. Files use the `.yaml` extension (not `.yml`). Comments are encouraged — OrgLoop config is meant to be read by the team, and routing decisions deserve annotation.

## Project Layout

An OrgLoop project is a directory containing `.yaml` files organized by convention:

```
my-org/
├── orgloop.yaml          # Project manifest (required)
├── connectors/           # Connector definitions
│   ├── github.yaml
│   ├── linear.yaml
│   └── openclaw.yaml
├── routes/               # Route definitions
│   └── engineering.yaml
├── transforms/           # Transform definitions
│   ├── transforms.yaml
│   └── custom-filter.sh
├── sops/                 # Launch prompt files (SOPs for actors)
│   ├── pr-review.md
│   ├── ci-failure.md
│   └── linear-ticket.md
└── loggers/              # Logger definitions
    └── default.yaml
```

## API Version and Kind

Every YAML file starts with `apiVersion` and `kind`:

```yaml
apiVersion: orgloop/v1alpha1
kind: Project  # or ConnectorGroup, RouteGroup, TransformGroup, LoggerGroup
```

| Kind | Purpose |
|------|---------|
| `Project` | Root project manifest (`orgloop.yaml`) |
| `ConnectorGroup` | Source and/or actor definitions |
| `RouteGroup` | Route definitions |
| `TransformGroup` | Transform definitions |
| `LoggerGroup` | Logger definitions |

## Project Manifest

The root `orgloop.yaml` declares the project and references external YAML files for connectors, routes, transforms, and loggers. The arrays contain **file paths** (relative to the project root), not package names.

```yaml
apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: my-org
  description: "Engineering organization event routing"

# Global defaults
defaults:
  poll_interval: 5m
  event_retention: 7d
  log_level: info

# Connector definition files
connectors:
  - connectors/github.yaml
  - connectors/linear.yaml
  - connectors/openclaw.yaml
  - connectors/claude-code.yaml

# Route definition files
routes:
  - routes/engineering.yaml

# Transform definition files
transforms:
  - transforms/transforms.yaml

# Logger definition files
loggers:
  - loggers/default.yaml
```

### Metadata Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `metadata.name` | string | Yes | Project name. Used in logs and diagnostics. |
| `metadata.description` | string | No | Human-readable project description. |

### Default Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaults.poll_interval` | duration | `5m` | Default polling interval for sources that don't specify their own. |
| `defaults.event_retention` | duration | `7d` | How long to retain event data. |
| `defaults.log_level` | string | `info` | Default log level: `debug`, `info`, `warn`, `error`. |

## Source Definition

Sources are defined inside `ConnectorGroup` YAML files. Each source is an instance of a connector package with specific configuration.

```yaml
apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

sources:
  - id: github
    description: GitHub PR and CI activity
    connector: "@orgloop/connector-github"
    config:
      repo: "${GITHUB_REPO}"
      token: "${GITHUB_TOKEN}"
      events:
        - "pull_request.review_submitted"
        - "pull_request_review_comment"
        - "issue_comment"
        - "pull_request.closed"
        - "pull_request.merged"
        - "workflow_run.completed"
    poll:
      interval: 5m
    emits:
      - resource.changed
```

### Source Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier for this source. Referenced by routes. |
| `description` | string | No | Human-readable description. |
| `connector` | string | Yes | Package name of the connector (e.g., `@orgloop/connector-github`). |
| `config` | object | Yes | Connector-specific configuration. |
| `poll.interval` | duration | No | Polling interval. Overrides project default. |
| `emits` | string[] | No | Event types this source emits. Informational/documentation. |

### Connector-Specific Source Config

**GitHub** (`@orgloop/connector-github`):

| Field | Type | Description |
|-------|------|-------------|
| `repo` | string | Repository in `owner/repo` format. |
| `token` | string | GitHub personal access token. Use `"${GITHUB_TOKEN}"`. |
| `events` | string[] | GitHub event types to poll for. |
| `authors` | string[] | Optional filter: only emit events from these authors. |

**Linear** (`@orgloop/connector-linear`):

| Field | Type | Description |
|-------|------|-------------|
| `team` | string | Linear team key. |
| `project` | string | Optional Linear project name filter. |
| `api_key` | string | Linear API key. Use `"${LINEAR_API_KEY}"`. |

Linear comment events include `issue_assignee` and `issue_creator` in provenance, enabling routes to filter by issue context (e.g., "only route if assignee is on the eng team").

**Coding Agent** (`@orgloop/connector-coding-agent`):

The generalized, harness-agnostic coding agent connector. Receives webhook events from any coding harness (Claude Code, Codex, OpenCode, Pi, Pi-rust) via POST to the runtime's `/webhook/:sourceId` endpoint. Events include a [normalized lifecycle payload](/spec/lifecycle-contract/) (`payload.lifecycle` and `payload.session`).

| Field | Type | Description |
|-------|------|-------------|
| `secret` | string | Optional HMAC-SHA256 secret for webhook signature validation. |
| `buffer_dir` | string | Optional directory for crash-recovery disk buffering (JSON Lines). |
| `platform` | string | Platform identifier. Defaults to source ID. |
| `harness` | string | Harness type (`claude-code`, `codex`, `opencode`, `pi`, `pi-rust`). Defaults to platform. |

**Claude Code** (`@orgloop/connector-claude-code`):

Backward-compatible alias for `@orgloop/connector-coding-agent`. Registers with ID `claude-code` and delegates to `CodingAgentSource`. Existing configs continue to work unchanged. For new projects, consider using `@orgloop/connector-coding-agent` directly for harness-agnostic routing.

**Webhook** (`@orgloop/connector-webhook`):

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | URL path to mount the webhook receiver on. |

## Actor Definition

Actors (targets) are also defined in `ConnectorGroup` files. An actor is an instance of a target connector.

```yaml
apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

actors:
  - id: openclaw-engineering-agent
    description: Engineering OpenClaw agent
    connector: "@orgloop/connector-openclaw"
    config:
      base_url: "http://127.0.0.1:18789"
      auth_token_env: "${OPENCLAW_WEBHOOK_TOKEN}"
      agent_id: engineering
      default_channel: slack
      default_to: "${OPENCLAW_DEFAULT_TO}"
```

### Actor Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier for this actor. Referenced by routes. |
| `description` | string | No | Human-readable description. |
| `connector` | string | Yes | Package name of the target connector. |
| `config` | object | Yes | Connector-specific configuration. |

### Connector-Specific Actor Config

**OpenClaw** (`@orgloop/connector-openclaw`):

| Field | Type | Description |
|-------|------|-------------|
| `base_url` | string | OpenClaw server URL. Default: `http://127.0.0.1:18789`. |
| `auth_token_env` | string | Webhook auth token. Use `"${OPENCLAW_WEBHOOK_TOKEN}"`. |
| `agent_id` | string | Target agent identifier. |
| `default_channel` | string | Default delivery channel (e.g., `slack`). |
| `default_to` | string | Default recipient. Use `"${OPENCLAW_DEFAULT_TO}"`. |

**Webhook** (`@orgloop/connector-webhook`):

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Target URL to POST events to. |
| `headers` | object | Optional HTTP headers to include. |
| `secret` | string | Optional HMAC secret for signing payloads. |

## Route Definition

Routes are the core wiring of OrgLoop. They declare: when source X emits event Y, run transforms, then deliver to actor Z with context C.

```yaml
apiVersion: orgloop/v1alpha1
kind: RouteGroup
metadata:
  name: engineering-routes
  description: "Engineering event routing"

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
      prompt_file: "./sops/pr-review.md"
```

### Route Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique route name. Used in logs and diagnostics. |
| `description` | string | No | Human-readable description. |

### `when` — Trigger

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `when.source` | string | Yes | Source ID to match events from. |
| `when.events` | string[] | Yes | Event types to match (e.g., `resource.changed`). |
| `when.filter` | object | No | Dot-path filter on event fields. All conditions must match. |

Filter uses dot-path notation to match nested event fields (all conditions must match):

```yaml
filter:
  provenance.platform_event: pull_request.review_submitted
  provenance.author_type: team_member
```

Route-level filters support exact value matching only. For regex patterns, array-contains logic, or complex boolean expressions, use the [transform-filter](/guides/transform-filter/) in your route's transform pipeline instead.

### `transforms` — Pipeline

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `transforms[].ref` | string | Yes | Name of a transform defined in a `TransformGroup`. |

Transforms are applied sequentially. If any transform drops the event (returns null or exits non-zero), the pipeline stops and the event is not delivered.

### `then` — Target

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `then.actor` | string | Yes | Actor ID to deliver the event to. |
| `then.config` | object | No | Actor-specific config passed alongside the event. |

The `then.config` fields are connector-specific. For OpenClaw:

| Field | Type | Description |
|-------|------|-------------|
| `session_key` | string | Session routing key. Supports `{{field}}` interpolation from event fields (e.g., `orgloop:github:pr:{{payload.pr_number}}`). |
| `thread_id` | string | Optional conversation thread grouping key. Supports `{{field}}` interpolation (e.g., `pr-{{payload.pr_number}}`). |
| `wake_mode` | string | When to wake the agent: `now`, `next`, `queue`. Default: `now`. |
| `deliver` | boolean | Whether to deliver the message to the agent's chat. Default: `false`. |
| `channel` | string | Override the actor's `default_channel` for this route. |
| `to` | string | Override the actor's `default_to` for this route. |

**Callback-first delivery:** When an event's payload contains `meta.openclaw_callback_session_key` (or `session.meta.openclaw_callback_session_key`), the OpenClaw connector delivers to that callback session first. If callback delivery fails, it falls back to normal routing. This enables chained agent supervision — an agent completes work, and its completion event routes back to the originating supervisor session.

**Template interpolation:** The `session_key` and `thread_id` fields support `{{double-brace}}` interpolation from event fields. Supported paths include `payload.*`, `provenance.*`, and top-level event fields (`source`, `type`). Missing values resolve to `"unknown"`.

### `with` — Launch Context

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `with.prompt_file` | string | No | Path to a Markdown SOP file. Resolved relative to the route YAML file's directory. |

`with` is optional. Routes without it deliver events without additional context.

Only `prompt_file` is supported. Launch prompts are Markdown files, not inline YAML strings. This enforces clean separation: route logic (when/then) lives in YAML, operational content (the SOP) lives in Markdown files.

Multiple routes can target the same actor with different launch prompts. The routing layer decides which SOP is relevant -- the actor does not need to figure it out.

`orgloop validate` checks that all referenced prompt files exist.

## Transform Definition

Transforms are defined inside `TransformGroup` YAML files. Two types are supported:

### Package Transforms

Reference a published transform package with configuration:

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

### Script Transforms

Shell scripts with a stdin/stdout contract:

```yaml
transforms:
  - name: custom-filter
    type: script
    script: ./custom-filter.sh
    timeout_ms: 5000
```

The script contract:
- **stdin:** Event JSON
- **Environment variables:** `$SOURCE`, `$TARGET`, `$EVENT_TYPE`
- **stdout with content:** Modified event JSON (event continues through pipeline)
- **Empty stdout or exit 1:** Event is filtered (dropped)

### Transform Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique transform name. Referenced by routes. |
| `type` | string | Yes | Either `package` or `script`. |
| `package` | string | If `type: package` | Package name of the transform. |
| `config` | object | No | Package-specific configuration. |
| `script` | string | If `type: script` | Path to the script file (relative to the YAML file). |
| `timeout_ms` | number | No | Script execution timeout in milliseconds. |

## Logger Definition

Loggers are passive observers that record pipeline activity. Every event, every transform, every delivery attempt is captured.

```yaml
apiVersion: orgloop/v1alpha1
kind: LoggerGroup
metadata:
  name: default-loggers

loggers:
  - name: file-log
    type: "@orgloop/logger-file"
    config:
      path: ~/.orgloop/logs/orgloop.log
      format: jsonl
      rotation:
        max_size: 100MB
        max_age: 7d
        compress: true

  - name: console-log
    type: "@orgloop/logger-console"
    config:
      level: info
      color: true
```

### Logger Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique logger name. |
| `type` | string | Yes | Package name of the logger. |
| `config` | object | No | Logger-specific configuration. |

### File Logger Config (`@orgloop/logger-file`)

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | Log file path. Supports `~` for home directory. |
| `format` | string | Output format: `jsonl`. |
| `rotation.max_size` | string | Maximum file size before rotation (e.g., `100MB`). |
| `rotation.max_age` | string | Maximum age before rotation (e.g., `7d`). |
| `rotation.compress` | boolean | Whether to gzip rotated files. |

### Console Logger Config (`@orgloop/logger-console`)

| Field | Type | Description |
|-------|------|-------------|
| `level` | string | Minimum log level: `debug`, `info`, `warn`, `error`. |
| `color` | boolean | Enable ANSI color output. |

## Environment Variable Substitution

Use `${VAR_NAME}` syntax in any config value. Variables are resolved at runtime, never stored in YAML.

```yaml
config:
  token: "${GITHUB_TOKEN}"
  repo: "${GITHUB_REPO}"
  api_key: "${LINEAR_API_KEY}"
  auth_token_env: "${OPENCLAW_WEBHOOK_TOKEN}"
```

Rules:
- The `${...}` syntax works in any string value in any config block.
- Variables are resolved when config is loaded (during `validate`, `plan`, and `start`).
- Missing variables cause a clear error with the variable name and which config field references it.
- Secrets should always use env var substitution. Never put credentials directly in YAML.
- Use `orgloop env` to check which variables are set and which are missing.

## File Path Resolution

- Paths in the project manifest (`connectors`, `routes`, `transforms`, `loggers`) are resolved relative to the project root (the directory containing `orgloop.yaml`).
- Paths inside referenced YAML files (`script`, `prompt_file`) are resolved relative to the YAML file that contains them.
- The `~` prefix is expanded to the user's home directory.
- `orgloop validate` verifies that all referenced files exist.

## Complete Example

```yaml
# orgloop.yaml
apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: engineering-org
  description: "Autonomous engineering organization"

defaults:
  poll_interval: 5m
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
