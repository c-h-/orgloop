---
title: Projects
description: An OrgLoop project is a directory with orgloop.yaml and package.json — standard npm tooling, no custom module system.
---

An OrgLoop **project** is a directory with two files at its root: `orgloop.yaml` (your routing config) and `package.json` (your plugin dependencies). No custom module system, no manifests, no template expansion -- just standard npm tooling.

```
my-org/
  orgloop.yaml              # Project config: metadata, defaults, file references
  package.json              # Dependencies: connectors, transforms, loggers
  .env.example              # Required environment variables (reference)
  connectors/
    github.yaml             # Source: GitHub repository events
    openclaw.yaml           # Actor: OpenClaw agent delivery
  routes/
    pr-review.yaml          # Route: PR reviews -> engineering agent
    ci-failure.yaml         # Route: CI failures -> engineering agent
  transforms/
    transforms.yaml         # Transform definitions
    drop-bot-noise.sh       # Script transform
  loggers/
    default.yaml            # File logger config
  sops/
    pr-review.md            # Launch prompt for PR review events
    ci-failure.md           # Launch prompt for CI failure events
```

## Scaffolding a Project

`orgloop init` creates this structure interactively:

```bash
$ orgloop init

  Project name: my-org
  Description: Engineering event routing
  Which connectors? [github, linear, openclaw, claude-code]

  Created:
    orgloop.yaml
    package.json
    connectors/github.yaml
    connectors/linear.yaml
    connectors/openclaw.yaml
    connectors/claude-code.yaml
    routes/example.yaml
    transforms/transforms.yaml
    transforms/drop-bot-noise.sh
    loggers/default.yaml
    sops/example.md
    .env.example
    .gitignore

  Environment variables:
    ✗ GITHUB_REPO              connectors/github.yaml
    ✗ GITHUB_TOKEN             connectors/github.yaml
    ✗ LINEAR_TEAM_KEY          connectors/linear.yaml
    ...

  Next: run `npm install` to install dependencies,
        then `orgloop doctor` to check your environment.
```

Non-interactive mode for CI and scripts:

```bash
orgloop init --name my-org --connectors github,openclaw --no-interactive
```

## package.json

The scaffolded `package.json` lists `@orgloop/*` packages as dependencies. This is how the CLI knows which plugins are available at runtime.

```json
{
  "private": true,
  "description": "OrgLoop project: my-org",
  "dependencies": {
    "@orgloop/connector-claude-code": "^0.1.9",
    "@orgloop/connector-github": "^0.1.9",
    "@orgloop/connector-linear": "^0.1.9",
    "@orgloop/connector-openclaw": "^0.1.9",
    "@orgloop/core": "^0.1.9",
    "@orgloop/logger-file": "^0.1.9"
  }
}
```

After scaffolding, install dependencies with your package manager:

```bash
npm install
# or
pnpm install
```

## orgloop.yaml

The project config references connector, transform, and logger YAML files by path:

```yaml
apiVersion: orgloop/v1alpha1
kind: Project

metadata:
  name: my-org
  description: "Engineering event routing"

defaults:
  poll_interval: "5m"
  event_retention: "30d"
  log_level: info

connectors:
  - connectors/github.yaml
  - connectors/openclaw.yaml

transforms:
  - transforms/transforms.yaml

loggers:
  - loggers/default.yaml
```

Routes are auto-discovered from the `routes/` directory -- any `.yaml` or `.yml` file in that directory is loaded automatically. You do not need to list route files in `orgloop.yaml`.

## Plugin Resolution

When you run `orgloop start`, the CLI resolves plugins from your project's `node_modules/`:

1. Reads `orgloop.yaml` and all referenced YAML files
2. Collects connector package names from source/actor `connector:` fields (e.g., `@orgloop/connector-github`)
3. Dynamically imports each package from the project directory's `node_modules/`
4. Calls the package's `register()` function to get a `ConnectorRegistration`
5. Instantiates source/actor connectors and passes them to the runtime

Resolution order:
1. **Project's `node_modules/`** -- packages you installed with `npm install`
2. **CLI's own `node_modules/`** -- fallback for monorepo workspaces and bundled packages

If a package cannot be found, the CLI tells you exactly what to install:

```
Failed to import connector "@orgloop/connector-github": Cannot find module
  Hint: run `npm install @orgloop/connector-github` in your project directory.
```

## Adding a New Connector

Adding a connector is two steps: install the npm package, then add a YAML config file.

```bash
# 1. Install the package
npm install @orgloop/connector-webhook

# 2. Create a connector config
cat > connectors/webhook.yaml << 'EOF'
apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

sources:
  - id: webhook
    description: Generic webhook receiver
    connector: "@orgloop/connector-webhook"
    config:
      path: "/webhook"
    emits:
      - resource.changed
      - message.received
EOF

# 3. Reference it in orgloop.yaml
# Add "- connectors/webhook.yaml" to the connectors list
```

Then add a route in `routes/` to wire the new source to an actor, and run `orgloop plan` to verify the expanded config.

## Adding Transforms and Loggers

Same pattern -- install the package, add the YAML config:

```bash
# Install a package transform
npm install @orgloop/transform-dedup

# Add to transforms/transforms.yaml
```

```yaml
# transforms/transforms.yaml
transforms:
  - name: dedup
    type: package
    package: "@orgloop/transform-dedup"
    config:
      window: 1h
```

Script transforms do not require npm packages -- they are shell scripts referenced by path in your transform YAML.

## Environment Variables

Secrets are never stored in YAML. Use `${VAR_NAME}` substitution:

```yaml
config:
  repo: "${GITHUB_REPO}"
  token: "${GITHUB_TOKEN}"
```

`orgloop init` generates a `.env.example` listing every variable referenced in your connector configs. Copy it to `.env` and fill in values. Run `orgloop env` to check which variables are set and which are missing.

## Validation Workflow

Before starting the system, validate your project:

```bash
orgloop validate    # Schema validation on all YAML files
orgloop env         # Check environment variable status
orgloop doctor      # Full health check (vars, services, credentials)
orgloop plan        # Show the expanded config (all routes, sources, actors)
orgloop start       # Run the system
```

Each command builds on the previous. Fix issues early -- `validate` catches config errors, `env` catches missing secrets, `doctor` catches missing services, `plan` shows the full picture before anything runs.
