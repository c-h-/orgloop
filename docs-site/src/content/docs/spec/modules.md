---
title: "Project Model"
description: "Package-native project structure, orgloop.yaml schema, plugin resolution, YAML file formats, environment variable substitution, and route auto-discovery."
---

> **Status: Implemented (v0.1.9).** Projects are package-native. A project is a directory with `orgloop.yaml` + `package.json`. Connectors, transforms, and loggers are npm packages installed via `npm install`. Routes are auto-discovered from the `routes/` directory.

### What Is a Project?

A **project** is a directory that contains an OrgLoop configuration. It has two required files:

- **`orgloop.yaml`** -- the project manifest. Declares metadata, defaults, and file paths to connector, transform, and logger YAML files.
- **`package.json`** -- the dependency manifest. Lists `@orgloop/*` packages (connectors, transforms, loggers) as dependencies.

```
my-org/
├── orgloop.yaml              # Project manifest
├── package.json              # npm dependencies (@orgloop/connector-*, etc.)
├── connectors/
│   ├── github.yaml           # ConnectorGroup: sources and actors
│   ├── linear.yaml
│   ├── claude-code.yaml
│   └── openclaw.yaml
├── routes/
│   └── engineering.yaml      # RouteGroup: auto-discovered from routes/
├── transforms/
│   └── transforms.yaml       # TransformGroup: filter, dedup, etc.
├── loggers/
│   └── default.yaml          # LoggerGroup: file, console, etc.
├── sops/                     # Launch prompt files (markdown)
│   ├── pr-review.md
│   └── ci-failure.md
└── node_modules/             # Installed packages (gitignored)
```

This is the entire model. A project is a flat, explicit directory of YAML files and npm packages. `orgloop init` scaffolds it. `orgloop start` runs it.

### Project Config (`orgloop.yaml`)

The root configuration file declares the project identity, defaults, and references to YAML files that define the project's connectors, transforms, and loggers.

```yaml
# orgloop.yaml
apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: engineering-org
  description: "Engineering organization event routing"

defaults:
  poll_interval: 5m
  event_retention: 7d
  log_level: info

connectors:
  - connectors/github.yaml
  - connectors/linear.yaml
  - connectors/claude-code.yaml
  - connectors/openclaw.yaml

transforms:
  - transforms/transforms.yaml

loggers:
  - loggers/default.yaml
```

**Schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `apiVersion` | string | Yes | API version (`orgloop/v1alpha1`) |
| `kind` | `"Project"` | Yes | Must be `Project` |
| `metadata.name` | string | Yes | Project name (used for runtime identity) |
| `metadata.description` | string | No | Human-readable description |
| `defaults.poll_interval` | string | No | Default poll interval for sources |
| `defaults.event_retention` | string | No | Event retention period |
| `defaults.log_level` | string | No | Default log level |
| `connectors` | string[] | No | Paths to ConnectorGroup YAML files |
| `transforms` | string[] | No | Paths to TransformGroup YAML files |
| `loggers` | string[] | No | Paths to LoggerGroup YAML files |

All file paths are resolved relative to the directory containing `orgloop.yaml`.

Routes are NOT listed in `orgloop.yaml`. They are auto-discovered from the `routes/` directory (see [Route Auto-Discovery](#route-auto-discovery)).

### `package.json` as Dependency Manifest

Connectors, transforms, and loggers are npm packages. The project's `package.json` declares them as dependencies:

```json
{
  "name": "my-org",
  "private": true,
  "dependencies": {
    "@orgloop/connector-github": "^0.1.0",
    "@orgloop/connector-linear": "^0.1.0",
    "@orgloop/connector-claude-code": "^0.1.0",
    "@orgloop/connector-openclaw": "^0.1.0",
    "@orgloop/connector-cron": "^0.1.0",
    "@orgloop/transform-filter": "^0.1.0",
    "@orgloop/transform-dedup": "^0.1.0",
    "@orgloop/transform-enrich": "^0.1.0",
    "@orgloop/logger-file": "^0.1.0",
    "@orgloop/logger-console": "^0.1.0"
  }
}
```

Install everything with `npm install` (or `pnpm install`). The CLI resolves packages from the project's `node_modules/` at startup.

### Plugin Resolution

When `orgloop start` runs, the CLI dynamically imports each connector, transform, and logger package referenced in the YAML config. The resolution order:

1. **Project `node_modules/`** -- packages installed in the project directory (preferred)
2. **CLI `node_modules/`** -- packages bundled with or installed alongside `@orgloop/cli` (fallback)

If a package is not found in either location, the CLI reports the error and suggests the install command:

```
  Error: Connector "@orgloop/connector-linear" not found.
  Fix: npm install @orgloop/connector-linear
```

Resolution uses Node's standard `import()` with `createRequire()` scoped to the project directory, so the project's `node_modules/` takes priority. This means a project can pin specific versions of connectors independently of the CLI version.

### YAML File Formats

Each YAML file has a `kind` field that identifies its type. All share the same `apiVersion`.

#### ConnectorGroup

Defines sources (poll-based or hook-based) and actors (delivery targets).

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
        - "workflow_run.completed"
    poll:
      interval: 5m
    emits:
      - resource.changed

actors:
  - id: openclaw-engineering-agent
    description: OpenClaw agent delivery
    connector: "@orgloop/connector-openclaw"
    config:
      agent: "${OPENCLAW_AGENT}"
      webhook_url: "http://127.0.0.1:18789/hooks/agent"
      token: "${OPENCLAW_WEBHOOK_TOKEN}"
```

#### RouteGroup

Defines event routing rules: which source events match, what transforms to apply, and which actor receives the event.

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
    with:
      prompt_file: "./sops/pr-review.md"
```

#### TransformGroup

Defines transforms (package-based or script-based) that filter, deduplicate, or enrich events in the pipeline.

```yaml
apiVersion: orgloop/v1alpha1
kind: TransformGroup

transforms:
  - name: drop-bot-noise
    type: "@orgloop/transform-filter"
    config:
      exclude:
        provenance.author: "/\\[bot\\]$/"

  - name: dedup
    type: "@orgloop/transform-dedup"
    config:
      window: 1h
      key_fields:
        - source
        - type
        - provenance.platform_event_id
```

#### LoggerGroup

Defines loggers that observe the event pipeline.

```yaml
apiVersion: orgloop/v1alpha1
kind: LoggerGroup

loggers:
  - name: file-log
    type: "@orgloop/logger-file"
    config:
      path: "~/.orgloop/logs/orgloop.log"
      format: jsonl
      rotate:
        max_size: 10mb
        max_age: 7d
        max_files: 5

  - name: console-log
    type: "@orgloop/logger-console"
    config:
      level: info
```

### Environment Variable Substitution

YAML config files support `${VAR_NAME}` syntax for environment variable substitution. Variables are resolved at config load time (during `orgloop start`, `orgloop validate`, `orgloop plan`).

```yaml
config:
  repo: "${GITHUB_REPO}"
  token: "${GITHUB_TOKEN}"
```

If a referenced variable is not set, config loading fails with an error identifying the missing variable and the file that references it.

Use `orgloop env` to check which variables are required and which are set:

```bash
$ orgloop env

Environment Variables:

  ok GITHUB_TOKEN       connectors/github.yaml
  !! LINEAR_API_KEY     connectors/linear.yaml
    -> Linear personal API key
    -> https://linear.app/settings/api
  ok OPENCLAW_WEBHOOK_TOKEN  connectors/openclaw.yaml

2 of 3 variables set. 1 missing.
```

### Route Auto-Discovery

Routes are auto-discovered from the `routes/` directory relative to `orgloop.yaml`. The CLI scans for all `.yaml` and `.yml` files in this directory and loads them as RouteGroup files.

```
my-org/
├── orgloop.yaml
└── routes/
    ├── engineering.yaml     # Loaded automatically
    ├── supervision.yaml     # Loaded automatically
    └── experimental.yaml    # Loaded automatically
```

This means adding a new route is as simple as creating a new YAML file in `routes/`. No changes to `orgloop.yaml` required.

Routes are NOT listed in `orgloop.yaml`. The `connectors`, `transforms`, and `loggers` arrays are explicit file references. Routes use directory-based auto-discovery. This asymmetry is intentional: routes change frequently (new workflows, new event patterns), while connectors and loggers are stable infrastructure.

Prompt file paths in routes (`with.prompt_file`) are resolved relative to the route YAML file, not the project root. This allows routes to reference SOPs in a co-located `sops/` directory:

```yaml
# routes/engineering.yaml
routes:
  - name: github-pr-review
    # ...
    with:
      prompt_file: "../sops/pr-review.md"  # Relative to routes/
```

### How It Works at Runtime

When you run `orgloop start`, the CLI:

1. Reads `orgloop.yaml` from CWD (or `--config` path)
2. Loads all referenced ConnectorGroup, TransformGroup, and LoggerGroup YAML files
3. Auto-discovers RouteGroup files from `routes/`
4. Resolves `${VAR}` references in all loaded YAML
5. Dynamically imports connector/transform/logger packages from the project's `node_modules/`
6. Creates a `Runtime` instance and loads the project as a single unit

The runtime receives the fully resolved config -- sources, actors, routes, transforms, loggers -- and starts polling, routing, and delivering events. The project directory structure is a config-time concern; the runtime only sees the resolved primitives.

Run `orgloop plan` to see exactly what the resolved config looks like before starting. Run `orgloop validate` to check config syntax and reference integrity without starting.

### Relationship to Internal Architecture

Internally, the runtime uses `ModuleInstance` and `ModuleRegistry` classes to manage workload lifecycle. The CLI loads the project config via `runtime.loadModule()`. These are implementation details -- the user-facing model is a project. The internal abstraction exists to support potential future capabilities (multi-project runtimes, dynamic workload management) without breaking the current single-project model.

For the runtime architecture, see [Runtime Lifecycle](./runtime-lifecycle/). For CLI commands, see [CLI Design](./cli-design/).
