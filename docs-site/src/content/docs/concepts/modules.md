---
title: Modules
description: Composable workflow packages — install a complete business process with one command.
---

A **module** is a bundled workflow: connectors + routes + transforms + SOPs, packaged as a single installable unit. Think of it as "install this business process."

```bash
orgloop add module engineering
```

That one command installs a complete engineering organization workflow: PR review routing, CI failure triage, Linear ticket handling, Claude Code supervision -- 5 routes, 3 transforms, and 3 launch prompt SOPs.

## Why Modules?

Without modules, setting up an OrgLoop system means writing every source, actor, route, transform, and SOP from scratch. Modules package proven workflows so you can install them, configure parameters, and start routing events immediately.

Modules are:
- **Composable** -- multiple modules can share the same connectors
- **Parameterized** -- adapt to your specific source and actor names
- **Shareable** -- publish as npm packages for others to install
- **Degraded-mode friendly** -- run immediately even with some dependencies missing

## Installing a Module

```bash
# Full engineering org (GitHub, Linear, Claude Code, OpenClaw)
orgloop add module engineering

# Simplest possible setup (1 webhook source, 1 actor, 1 route)
orgloop add module minimal

# From a local path (during development)
orgloop add module my-workflow --path ./modules/my-workflow

# Non-interactive (for CI/scripts)
orgloop add module engineering --no-interactive \
  --params '{"github_source":"github","agent_actor":"engineering"}'
```

The `add module` command:
1. Resolves the module (local path or npm package)
2. Prompts for required parameters (interactive mode)
3. Copies connector configs, transforms, and SOPs into your project
4. Registers the module in `orgloop.yaml` under the `modules:` section
5. Route definitions expand at runtime from the module's templates

## Module Manifest

Every module contains an `orgloop-module.yaml` manifest that declares the full truth about what the module needs and provides.

```yaml
# orgloop-module.yaml
apiVersion: orgloop/v1alpha1
kind: Module
metadata:
  name: engineering
  description: "Engineering organization workflow"
  version: 1.0.0

requires:
  connectors:
    - type: source
      id: github
      connector: "@orgloop/connector-github"
      required: true

    - type: source
      id: linear
      connector: "@orgloop/connector-linear"
      required: false
      fallback: skip

    - type: source
      id: claude-code
      connector: "@orgloop/connector-claude-code"
      required: false
      fallback: skip

    - type: actor
      id: agent
      connector: "@orgloop/connector-openclaw"
      required: true

  services:
    - name: openclaw
      detect:
        http: "http://127.0.0.1:18789/health"
      install:
        brew: "openclaw"
        docs: "https://docs.openclaw.dev/install"

  credentials:
    - name: GITHUB_TOKEN
      description: "GitHub personal access token (repo scope)"
      required: true
      create_url: "https://github.com/settings/tokens/new?scopes=repo,read:org"

    - name: OPENCLAW_WEBHOOK_TOKEN
      description: "OpenClaw webhook authentication token"
      required: true

parameters:
  - name: github_source
    description: "Name of your GitHub source connector"
    type: string
    required: true
    default: github

  - name: agent_actor
    description: "Name of your agent actor"
    type: string
    required: true
    default: openclaw-engineering-agent

provides:
  routes: 5
  transforms: 3
  sops: 3
```

### Manifest Sections

| Section | Purpose | Consumed By |
|---------|---------|-------------|
| `requires.connectors` | Source and actor dependencies | OrgLoop (wiring) |
| `requires.services` | External services needed | `orgloop doctor`, external tools |
| `requires.credentials` | Environment variables needed | `orgloop doctor`, `orgloop env` |
| `requires.hooks` | Hooks that should be configured | `orgloop doctor`, external tools |
| `parameters` | User-provided config values | `orgloop add module` (interactive prompts) |
| `provides` | What the module installs | CLI output, documentation |

The `services`, `credentials`, and `hooks` sections are informational for OrgLoop -- it uses them for `orgloop doctor` reporting. External tools like `orgctl` can also read them for automated setup. OrgLoop functions correctly if these sections are absent.

## Parameterized Templates

Route templates use `{{ }}` substitution, expanded at plan/start time:

```yaml
# templates/routes.yaml
routes:
  - name: "{{ module.name }}-pr-review"
    when:
      source: "{{ params.github_source }}"
      events: [resource.changed]
      filter:
        provenance.platform_event:
          - pull_request.review_submitted
          - pull_request_review_comment
    transforms:
      - ref: drop-bot-noise
    then:
      actor: "{{ params.agent_actor }}"
    with:
      prompt_file: "{{ module.path }}/sops/pr-review.md"
```

Available template variables:

| Variable | Description |
|----------|-------------|
| `{{ params.X }}` | User-provided parameter value |
| `{{ module.name }}` | Module name (from manifest metadata) |
| `{{ module.path }}` | Filesystem path to the installed module |

## Composition Model

**Modules reference connectors; they do not create them.** This is the critical design decision.

A module declares what connectors it needs, and the user wires them up via parameters. Two modules that both need a GitHub source can point to the same one -- no conflict, because neither module owns the source.

```yaml
# orgloop.yaml -- Two modules sharing one GitHub source
sources:
  - id: github
    connector: "@orgloop/connector-github"
    config:
      repo: "${GITHUB_REPO}"
      token: "${GITHUB_TOKEN}"

actors:
  - id: engineering
    connector: "@orgloop/connector-openclaw"
    config:
      agent_id: engineering

modules:
  - package: "@orgloop/module-engineering"
    params:
      github_source: github
      agent_actor: engineering

  - package: "@orgloop/module-ci-monitor"
    params:
      github_source: github       # Same source, no conflict
      agent_actor: engineering
```

Each module adds its own routes. Routes do not conflict because OrgLoop supports multi-route matching -- one event can match multiple routes. Modules compose additively.

### Namespacing

Module routes are prefixed with the module name to avoid collisions:

- `engineering-pr-review`
- `engineering-ci-failure`
- `ci-monitor-build-status`

### Credential Isolation

Modules do not touch credentials. They declare connector dependencies. The user configures connectors (with credentials via env vars) independently.

## Progressive Onboarding

Modules support **degraded mode** -- they install and run immediately even when some dependencies are missing. Connectors marked `required: false` specify a fallback behavior:

| Fallback | Behavior |
|----------|----------|
| `skip` | Routes for this connector are silently omitted |
| `queue` | Events queue locally until the dependency is available |

```bash
$ orgloop add module engineering

  Checking dependencies...
    ✓ @orgloop/connector-github
    ✗ OpenClaw not detected at localhost:18789

  OpenClaw is required for live actor delivery.
  Without it, events will queue locally.

  ? Continue without OpenClaw? (Y/n): Y

  Module "engineering" installed (degraded).
    Actor "openclaw-engineering-agent" in queue mode.
    When ready: orgloop doctor && orgloop start
```

The system runs in degraded mode, queueing events until the missing dependency is available. When it comes online, queued events drain in order.

## Available Modules

| Module | Description | Routes | Transforms | SOPs |
|--------|-------------|--------|------------|------|
| `engineering` | Full engineering org: PR review, CI failure, Linear tickets, Claude Code supervision | 5 | 3 | 3 |
| `minimal` | Simplest starter: 1 webhook source, 1 actor, 1 route | 1 | 0 | 1 |

## Using Modules in orgloop.yaml

The `modules:` section in your project config references installed modules with their parameter bindings:

```yaml
# orgloop.yaml
modules:
  - package: "@orgloop/module-engineering"
    params:
      github_source: github
      linear_source: linear
      claude_code_source: claude-code
      agent_actor: engineering
```

Modules are **config-time only** for route template expansion -- the engine sees expanded routes, not raw templates. Run `orgloop plan` to see the expanded result.

## Building Your Own

A module is a directory (or npm package) with an `orgloop-module.yaml` manifest and supporting files:

```
my-module/
  orgloop-module.yaml       # Module manifest
  package.json              # npm metadata
  connectors/               # Connector YAMLs
  transforms/               # Transform definitions
  templates/
    routes.yaml             # Parameterized route templates
  sops/                     # Launch prompt files
```

For a step-by-step guide, see [Building Modules](/guides/module-authoring/).

## Runtime Integration

At runtime, modules are dynamically loaded via `Runtime.loadModule()` and managed as `ModuleInstance` objects with independent lifecycles:

| State | Meaning |
|-------|---------|
| `loading` | Module is initializing sources, actors, and transforms |
| `active` | Module is running and processing events |
| `unloading` | Module is shutting down its resources |
| `removed` | Module has been fully unloaded |

Each `ModuleInstance` owns its sources, actors, routes, and transforms. The `Runtime` owns shared infrastructure (EventBus, Scheduler, LoggerManager, HTTP server). This separation allows modules to be loaded, unloaded, and reloaded independently without affecting each other.

The CLI provides module management commands:

```bash
orgloop module list          # List all loaded modules
orgloop module status <name> # Show module state and resources
orgloop module load <name>   # Load a module at runtime
orgloop module unload <name> # Unload a module at runtime
orgloop module reload <name> # Reload a module (unload + load)
```

These commands communicate with the running daemon via the HTTP control API (`/control/module/*`).
