---
title: Building Modules
description: How to create and publish reusable workflow modules for OrgLoop.
---

A module is a bundled workflow -- connectors, routes, transforms, and prompt files packaged together as a single installable unit. Think of it as "install this business process."

```bash
npm install @orgloop/module-code-review
orgloop add module @orgloop/module-code-review
```

This scaffolds connector configs, routes, recommended transforms, and launch prompt SOPs -- a working org spec that the user configures with their repos, agents, and credentials.

## Module structure

```
my-module/
  package.json            # npm package metadata
  orgloop-module.yaml     # Module manifest (the contract)
  templates/
    routes.yaml           # Parameterized route definitions
  sops/                   # Launch prompt files
    review.md
    triage.md
  README.md
```

Modules are npm packages. The `orgloop-module.yaml` manifest is the only required file beyond `package.json` -- it declares everything OrgLoop needs to install and run the module.

## Writing the manifest

The manifest declares the full truth about what a module needs. It is designed for multiple consumers: OrgLoop reads connectors, routes, and parameters; external tools like [orgctl](https://github.com/c-h-/orgloop/blob/main/docs/rfp-orgctl.md) read services, credentials, and hooks.

```yaml
# orgloop-module.yaml
apiVersion: orgloop/v1alpha1
kind: Module
metadata:
  name: monitoring
  description: "Service monitoring with alert routing"
  version: 1.0.0

requires:
  connectors:
    - type: source
      id: webhook
      connector: "@orgloop/connector-webhook"
      required: true

    - type: actor
      id: agent
      connector: "@orgloop/connector-openclaw"
      required: false
      fallback: queue         # Events queue locally until actor is available

  services:
    - name: openclaw
      detect:
        http: "http://127.0.0.1:18789/health"
      install:
        brew: "openclaw"
        docs: "https://docs.openclaw.dev/install"
      provides_credentials:
        - OPENCLAW_WEBHOOK_TOKEN

  credentials:
    - name: OPENCLAW_WEBHOOK_TOKEN
      description: "OpenClaw webhook authentication token"
      required: false
      create_url: "https://docs.openclaw.dev/webhooks"

  hooks:
    - type: claude-code-stop
      required: false
      scope: global

parameters:
  - name: webhook_source
    description: "Name of your webhook source"
    type: string
    required: true
  - name: agent_actor
    description: "Name of your agent actor"
    type: string
    required: true
  - name: alert_threshold
    description: "Number of failures before alerting"
    type: number
    required: false
    default: 3

provides:
  routes: 2
  transforms: 0
  sops: 2
```

### Manifest sections

#### `metadata`

Module identity. The `name` field must be lowercase alphanumeric with hyphens (validated by JSON Schema: `^[a-z0-9][a-z0-9-]*$`).

#### `requires.connectors`

Connector dependencies. Each entry declares:

| Field | Purpose |
|-------|---------|
| `type` | `source` or `actor` |
| `id` | Connector ID referenced in templates |
| `connector` | npm package name |
| `required` | Whether the module can function without this connector (default: `true`) |
| `fallback` | What to do when the connector is unavailable: `queue` (store events locally) or `skip` (silently omit) |

Setting `required: false` with a `fallback` enables **degraded mode** -- the module installs and runs immediately even when some dependencies are missing.

#### `requires.credentials`

Environment variables the module needs. OrgLoop uses these for `orgloop doctor` reporting. Each entry supports:

| Field | Purpose |
|-------|---------|
| `name` | Environment variable name |
| `description` | Human-readable description |
| `required` | Whether the credential is required |
| `create_url` | URL where the user can create/obtain this credential |
| `validate` | Validation method (e.g., `github.whoami`) |

#### `requires.services`

External service dependencies. OrgLoop uses `detect.http` for health checks in `orgloop doctor`. The `install` field provides setup guidance. These are informational -- OrgLoop functions correctly if services are absent.

#### `requires.hooks`

System hooks the module benefits from (e.g., Claude Code post-exit hooks). Informational for `orgloop doctor` and external tools.

#### `parameters`

User-provided configuration values. Parameters are config choices (which repo? which agent?), not secrets. Supported types: `string`, `number`, `boolean`. Parameters can have defaults.

#### `provides`

Informational counts of what the module provides. Displayed during installation.

## Route templates

Route templates use `{{ variable }}` syntax, expanded at `orgloop plan` time:

```yaml
# templates/routes.yaml
routes:
  - name: "{{ module.name }}-alert-routing"
    when:
      source: "{{ params.webhook_source }}"
      events: [resource.changed]
      filter:
        provenance.platform_event: alert.fired
    then:
      actor: "{{ params.agent_actor }}"
      config:
        alert_threshold: "{{ params.alert_threshold }}"
    with:
      prompt_file: "{{ module.path }}/sops/triage.md"

  - name: "{{ module.name }}-status-update"
    when:
      source: "{{ params.webhook_source }}"
      events: [resource.changed]
      filter:
        provenance.platform_event: status.changed
    then:
      actor: "{{ params.agent_actor }}"
    with:
      prompt_file: "{{ module.path }}/sops/review.md"
```

### Available template variables

| Variable | Resolves to |
|----------|-------------|
| `{{ params.X }}` | User-provided parameter value |
| `{{ module.name }}` | Module name from manifest metadata |
| `{{ module.path }}` | Resolved filesystem path to the module package |

Template expansion fails with a clear error if a referenced variable is missing.

## Composition

Modules **reference** connectors -- they do not create them. This is the critical design insight. A module declares what connectors it needs, and the user wires them via parameters. Two modules that both need a GitHub source can point to the same one.

```yaml
# orgloop.yaml
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

Each module adds its own routes. Routes compose additively -- one event can match multiple routes via multi-route matching. No conflicts because neither module owns the source connector.

### Namespacing

Route names are automatically prefixed with the module name: `code-review-pr-review`, `ci-monitor-ci-failure`. This prevents name collisions when multiple modules define routes.

### Credential isolation

Modules do not touch credentials. They declare connector dependencies. The user configures connectors (with credentials via environment variables) independently. Different lifecycles, different storage.

## Progressive onboarding

Modules support degraded mode -- they install and run immediately even when some dependencies are missing:

```
$ orgloop add module @orgloop/module-monitoring

  Checking dependencies...
    ✓ @orgloop/connector-webhook
    ✗ OpenClaw not detected at localhost:18789

  OpenClaw is required for live actor delivery.
  Without it, events will queue locally.

  ? Continue without OpenClaw? (Y/n): Y

  Module "monitoring" installed (degraded).
    Actor "agent" in queue mode.
    When ready: orgloop doctor && orgloop upgrade
```

When the dependency becomes available:

```
$ orgloop upgrade
  ✓ OpenClaw detected at localhost:18789
  ✓ Actor "agent" upgraded: queue → live
  ✓ 5 queued events delivered.
```

Queued events are stored as JSONL in `~/.orgloop/queue/<actor-id>/` and drain in order with original timestamps preserved.

## Testing locally

Test your module before publishing by pointing to the local path:

```bash
orgloop add module my-module --path ./my-module
```

This resolves the module from the filesystem instead of npm, letting you iterate on the manifest and templates without publishing.

Run `orgloop validate` to check that the manifest is well-formed, all template variables resolve, and connector references are valid. Then `orgloop plan` to see the expanded routes.

## Publishing

1. Ensure `orgloop-module.yaml` is valid: `orgloop validate`
2. Build any TypeScript if needed: `pnpm build`
3. Publish: `npm publish` (or `npm publish --access public` for scoped packages)
4. Users install: `npm install @orgloop/module-my-module && orgloop add module my-module`

### package.json

```json
{
  "name": "@orgloop/module-monitoring",
  "version": "1.0.0",
  "type": "module",
  "files": [
    "orgloop-module.yaml",
    "templates/",
    "sops/"
  ],
  "keywords": ["orgloop", "orgloop-module", "monitoring"]
}
```

Include `orgloop-module.yaml`, `templates/`, and `sops/` in the published package. The `orgloop-module` keyword helps with discoverability on npm.

## Example: walkthrough

Here is a complete minimal module that routes GitHub CI failures to an agent:

**orgloop-module.yaml:**

```yaml
apiVersion: orgloop/v1alpha1
kind: Module
metadata:
  name: ci-alerter
  description: "Route CI failures to an agent for investigation"
  version: 0.1.0

requires:
  connectors:
    - type: source
      id: github
      connector: "@orgloop/connector-github"
      required: true
    - type: actor
      id: agent
      connector: "@orgloop/connector-openclaw"
      required: false
      fallback: queue

  credentials:
    - name: GITHUB_TOKEN
      description: "GitHub personal access token (repo scope)"
      required: true
      create_url: "https://github.com/settings/tokens/new?scopes=repo,read:org"

parameters:
  - name: github_source
    description: "Name of your GitHub source connector"
    type: string
    required: true
  - name: agent_actor
    description: "Name of your agent actor"
    type: string
    required: true

provides:
  routes: 1
  sops: 1
```

**templates/routes.yaml:**

```yaml
routes:
  - name: "{{ module.name }}-ci-failure"
    when:
      source: "{{ params.github_source }}"
      events: [resource.changed]
      filter:
        provenance.platform_event: workflow_run.completed
    then:
      actor: "{{ params.agent_actor }}"
    with:
      prompt_file: "{{ module.path }}/sops/investigate.md"
```

**sops/investigate.md:**

```markdown
# CI Failure Investigation

A CI workflow has failed. Investigate the failure and determine:
1. Is this a flaky test or a real regression?
2. What commit introduced the failure?
3. What is the recommended fix?

Provide a summary and, if possible, open a fix PR.
```

See the [engineering module](https://github.com/c-h-/orgloop/tree/main/modules/engineering) for a production example with multiple routes, transforms, and SOPs.
