---
title: "Module System"
description: "Module manifest, parameterized templates, composition model, and progressive onboarding for installable workflow bundles."
---

> **Status: Implemented.** The module system is live. `orgloop add module <name>` installs workflow bundles with parameterized route definitions. Modules are the only mechanism for installing pre-built workflows.

### What Is a Module?

A **module** is a bundled workflow: connectors + routes + transforms + prompt files — a complete autonomous process installable as a single package. Think of it as "install this business process."

```bash
npm install @orgloop/module-code-review
orgloop add module code-review
```

This scaffolds: GitHub connector config, OpenClaw actor config, routes for PR review -> agent supervision, recommended transforms (injection scanner, bot noise filter), and launch prompt SOPs — a working org spec that you configure with your repo, agent, and credentials.

### Module Structure

A module is an npm package that exports:

```
@orgloop/module-code-review/
├── package.json          # npm package metadata
├── orgloop-module.yaml   # Module manifest
├── templates/
│   ├── routes.yaml       # Route templates (parameterized)
│   └── transforms.yaml   # Transform recommendations
├── sops/                 # Launch prompt files bundled with the module
│   ├── pr-review.md
│   └── ci-failure.md
└── README.md
```

### Module Manifest

The manifest declares the **full truth** about what a module needs. It is designed for multiple consumers: OrgLoop reads connectors, routes, and parameters; external tools like `orgctl` (see [orgctl RFP](https://orgloop.ai/vision/orgctl/)) read services, credentials, and hooks. See [Scope Boundaries](./scope-boundaries/) for the shared contract model.

```yaml
# orgloop-module.yaml
apiVersion: orgloop/v1alpha1
kind: Module
metadata:
  name: code-review
  description: "Automated code review workflow"
  version: 1.0.0

requires:
  # Connectors (OrgLoop reads these)
  connectors:
    - type: source
      id: github
      connector: "@orgloop/connector-github"
      required: true

    - type: actor
      id: agent
      connector: "@orgloop/connector-openclaw"
      required: false        # Can run in queue mode without it
      fallback: queue         # Events queue locally until actor is available

    - type: source
      id: claude-code
      connector: "@orgloop/connector-claude-code"
      required: false
      fallback: skip          # Module works without session tracking

  # Services (orgloop doctor reports; external tools install)
  services:
    - name: openclaw
      detect:
        http: "http://127.0.0.1:18789/health"
      install:
        brew: "openclaw"
        docs: "https://docs.openclaw.dev/install"
      provides_credentials:
        - OPENCLAW_WEBHOOK_TOKEN

  # Credentials (orgloop doctor reports; external tools broker)
  credentials:
    - name: GITHUB_TOKEN
      description: "GitHub personal access token (repo scope)"
      required: true
      create_url: "https://github.com/settings/tokens/new?scopes=repo,read:org"
      validate: "github.whoami"

    - name: OPENCLAW_WEBHOOK_TOKEN
      description: "OpenClaw webhook authentication token"
      required: false           # Not required if actor is in queue mode

  # Hooks (orgloop doctor reports; external tools configure)
  hooks:
    - type: claude-code-stop
      required: false
      scope: global

# Parameters the user must provide
parameters:
  - name: github_source
    description: "Name of your GitHub source"
    type: string
    required: true
  - name: agent_actor
    description: "Name of your agent actor"
    type: string
    required: true

# What this module provides
provides:
  routes: 2
  transforms: 0
  sops: 2
```

**Key design decisions:**

- **`required: false` with `fallback`** enables degraded mode. Actors can use `queue` (events stored locally until available) or `skip` (silently omitted).
- **`services`, `credentials`, `hooks`** are informational for OrgLoop. It uses them for `orgloop doctor` reporting. External tools use them for installation and credential brokering.
- **OrgLoop functions correctly if `services`, `credentials`, and `hooks` are absent.** They are an enrichment, not a requirement.
- **Parameters vs. credentials.** Parameters are config choices (which repo?). Credentials are secrets (API tokens). Different lifecycles, different storage.

### Parameterized Templates

Route templates use parameter substitution, expanded at `orgloop plan` time:

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
      - ref: injection-scanner
    then:
      actor: "{{ params.agent_actor }}"
      config:
        session_key: "hook:github:pr-review:{{ params.agent_actor }}"
    with:
      prompt_file: "{{ module.path }}/sops/pr-review.md"

  - name: "{{ module.name }}-ci-failure"
    when:
      source: "{{ params.github_source }}"
      events: [resource.changed]
      filter:
        provenance.platform_event: workflow_run.completed
    then:
      actor: "{{ params.agent_actor }}"
      config:
        session_key: "hook:github:ci-failure:{{ params.agent_actor }}"
    with:
      prompt_file: "{{ module.path }}/sops/ci-failure.md"
```

### Composition Model: Instantiation, Not Merging

**Modules don't create connectors. They reference them.** This is the critical insight from Terraform.

A module declares what connectors it needs, and the user wires them up via parameters. Two modules that both need a GitHub source can point to the same one — no conflict, because neither module owns the source.

```yaml
# orgloop.yaml — Two modules, one GitHub source
modules:
  - package: "@orgloop/module-code-review"
    params:
      github_source: github
      agent_actor: engineering

  - package: "@orgloop/module-ci-monitor"
    params:
      github_source: github        # Same source, no conflict
      agent_actor: engineering
```

Each module adds its own routes. Routes don't conflict because multi-route matching is already supported — one event can match multiple routes. The modules compose additively.

**Namespacing:** Module routes are namespaced with the module name as a prefix: `code-review-pr-review` vs `ci-monitor-ci-failure`.

**Credential isolation:** Modules don't touch credentials. They declare connector dependencies. The user configures the connectors (with credentials via env vars) independently.

### Progressive Onboarding

Modules support **degraded mode** — they install and run immediately even when some dependencies are missing. This follows OrgLoop's core philosophy: *you don't need reliable actors if you have a reliable system around them.*

```bash
$ orgloop add module code-review

  Checking dependencies...
    ✓ @orgloop/connector-github
    ✗ OpenClaw not detected at localhost:18789

  OpenClaw is required for live actor delivery.
  Without it, events will queue locally.

  ? Continue without OpenClaw? (Y/n): Y

  Module "code-review" installed (degraded).
    Actor "openclaw-engineering-agent" in queue mode.
    When ready: orgloop doctor && orgloop upgrade
```

Later, when the dependency is available:

```bash
$ orgloop upgrade
  ✓ OpenClaw detected at localhost:18789
  ✓ Actor "openclaw-engineering-agent" upgraded: queue → live
  ✓ 12 queued events delivered.
```

The queue actor implements `ActorConnector`, storing events as JSONL in `~/.orgloop/queue/<actor-id>/`. When the real actor becomes available, queued events drain in order with original timestamps preserved.

### Runtime Integration

Modules are first-class runtime citizens. The `Runtime` class (`packages/core/src/runtime.ts`) manages module lifecycle directly:

```typescript
import { Runtime } from '@orgloop/core';

const runtime = new Runtime();
await runtime.start();

// Load a module into the running runtime
await runtime.loadModule(moduleConfig, { sources, actors });

// Manage modules dynamically
await runtime.unloadModule('engineering');
await runtime.reloadModule('engineering', updatedConfig, { sources, actors });
```

Each module becomes a `ModuleInstance` with its own lifecycle states (`loading` -> `active` -> `unloading` -> `removed`), health tracking, and per-module resources (sources, actors, transforms, loggers). Shared infrastructure (event bus, scheduler, logger manager) is owned by the Runtime and shared across all loaded modules.

The CLI exposes this via `orgloop module load|unload|reload|list|status` commands that communicate with the running Runtime through its HTTP control API. See [Runtime & Module Lifecycle](./runtime-lifecycle/) for the full architecture and [CLI Design](./cli-design/) for command reference.
