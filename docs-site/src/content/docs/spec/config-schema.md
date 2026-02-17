---
title: "Config & Schema Definitions"
description: "YAML config format, project manifest, source/actor/route/transform/logger definitions, and plugin interface contracts."
---

### Schema Format: YAML

**Decision:** YAML for configuration files, with JSON Schema for validation.

**Rationale:**
- DESIGN.md already uses YAML for all examples — no switching cost.
- Supports comments (critical for config-as-code — people need to annotate routing decisions).
- Human-readable and writable. OaC files are meant to be read by the team; readability wins.
- JSON Schema provides programmatic validation; the CLI runs it on `orgloop validate`.
- HCL was considered but adds a learning curve and tooling dependency that isn't justified at our scale.
- TOML was considered but is awkward for deeply nested structures (routes with transforms with configs).

**File extension:** `.yaml` (not `.yml` — be explicit).

**File layout:** An OrgLoop project is a directory containing `.yaml` files organized by convention:

```
my-org/
├── orgloop.yaml          # Project manifest (required)
├── connectors/           # Connector definitions
│   ├── github.yaml
│   ├── linear.yaml
│   └── openclaw.yaml
├── routes/               # Route definitions
│   └── engineering.yaml
├── transforms/           # Transform definitions (or inline scripts)
│   ├── drop-bot-noise.sh
│   └── custom-filter.sh
├── sops/                 # Launch prompt files (SOPs for actors)
│   ├── pr-review.md
│   ├── ci-failure.md
│   └── linear-ticket.md
└── loggers/              # Logger definitions
    └── default.yaml
```

### 3.1 Project Manifest

The root `orgloop.yaml` declares the project and references external YAML files for connectors, transforms, and loggers. The `connectors`, `transforms`, and `loggers` arrays contain **file paths** (relative to the project root), not package names. Package names live inside the referenced YAML files.

```yaml
# orgloop.yaml — Project manifest
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

# Connector definition files (file paths, not package names)
connectors:
  - connectors/github.yaml
  - connectors/linear.yaml
  - connectors/openclaw.yaml
  - connectors/claude-code.yaml

# Transform definition files
transforms:
  - transforms/transforms.yaml

# Logger definition files
loggers:
  - loggers/default.yaml
```

### 3.2 Source Definition

Sources are defined inside `ConnectorGroup` YAML files. Each file can declare multiple sources and/or actors.

```yaml
# connectors/github.yaml
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

### 3.3 Actor (Target) Definition

Actors are also defined inside `ConnectorGroup` YAML files.

```yaml
# connectors/openclaw.yaml
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

### 3.4 Route Definition

Routes declare `when` (trigger), `then` (target), and optionally `with` (launch context). The `with` property provides **launch prompts** — focused, situational instructions delivered alongside the event to tell the actor how to approach this specific event type.

This is the same architectural pattern as OpenClaw Skills: focused, situational loading beats a grab-bag of instructions. The actor's identity and capabilities live with the actor (HEARTBEAT.md, skills). The event-specific SOPs live with the route.

```yaml
# routes/engineering.yaml
apiVersion: orgloop/v1alpha1
kind: RouteGroup
metadata:
  name: engineering-routes
  description: "Engineering event routing"

routes:
  - name: github-pr-review
    description: "PR review submitted → Engineering agent"

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

    # Launch prompt — situational instructions for this specific event type
    with:
      prompt_file: "./sops/pr-review.md"

  - name: github-ci-failure
    description: "CI failure → Engineering agent"

    when:
      source: github
      events:
        - resource.changed
      filter:
        provenance.platform_event: workflow_run.completed

    transforms:
      - ref: dedup

    then:
      actor: openclaw-engineering-agent
      config:
        session_key: "hook:github:ci-failure:engineering"
        wake_mode: now

    with:
      prompt_file: "./sops/ci-failure.md"

  - name: claude-code-to-supervisor
    description: "Claude Code completion → Supervisor"

    when:
      source: claude-code
      events:
        - actor.stopped

    then:
      actor: openclaw-engineering-agent
      config:
        session_key: "hook:claude-code:engineering"
        wake_mode: now

  - name: linear-to-project
    description: "Linear state change → Project agent"

    when:
      source: linear
      events:
        - resource.changed

    then:
      actor: openclaw-engineering-agent
      config:
        session_key: "hook:linear:activity:engineering"
        wake_mode: now
        deliver: true

    with:
      prompt_file: "./sops/linear-ticket.md"
```

#### The `with` Property

`with` is an **optional** route property. Routes without `with` work exactly as before — the event is delivered without additional context.

```yaml
# Route schema with `with`
routes:
  - name: string              # Required
    description: string        # Optional

    when:                      # Required — trigger
      source: string
      events: [string]
      filter: object           # Optional

    transforms: [...]          # Optional — pipeline steps

    then:                      # Required — target
      actor: string
      config: object

    with:                      # Optional — launch context
      prompt_file: string      # Path to a Markdown SOP file (relative to route YAML)
```

**Only `prompt_file` is supported.** Launch prompts are Markdown files, not inline YAML strings. This enforces clean separation: route logic (when/then) lives in YAML, operational content (the SOP) lives in Markdown files that work with every editor and preview tool.

**File resolution:** `prompt_file` paths are resolved relative to the route YAML file's directory. `orgloop validate` checks that all referenced prompt files exist.

**Delivery:** When OrgLoop delivers an event, the `RouteDeliveryConfig` includes `launch_prompt` (the resolved text) alongside any actor-specific config from `then.config`. Each actor connector decides how to format the outbound request. For example, the OpenClaw connector builds a `message` string from the event and launch prompt, and maps route config fields to OpenClaw's API format (`sessionKey`, `agentId`, `wakeMode`, `deliver`). The generic webhook connector sends the raw event and launch prompt:

```json
{
  "event": { "id": "evt_abc123", "type": "resource.changed", "..." : "..." },
  "launch_prompt": "# PR Review Received\n\nA team member submitted a review on your PR.\n..."
}
```

**Same actor, different prompts.** Multiple routes can target the same actor with different launch prompts. The routing layer decides which SOP is relevant — the actor doesn't need to figure it out.

**Reusability.** Multiple routes can reference the same SOP file with different event filters.

**Inspection:** `orgloop inspect route <name>` shows the associated prompt file and its contents.

### 3.5 Transform Definition

Transforms are defined inside `TransformGroup` YAML files. A single file can declare multiple transforms. Transforms can be:
1. **Shell scripts** — stdin/stdout contract (as specified in DESIGN.md)
2. **Package transforms** — referencing a transform package with config

```yaml
# transforms/transforms.yaml
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

  - name: custom-filter
    type: script
    script: ./custom-filter.sh
    timeout_ms: 5000
```

The shell script contract (unchanged from DESIGN.md):

```bash
#!/bin/bash
# transforms/drop-bot-noise.sh
#
# Contract:
#   stdin:  Event JSON
#   args:   $SOURCE, $TARGET, $EVENT_TYPE (set as env vars)
#   stdout: Modified event JSON → event continues
#   empty stdout or exit 1 → event is filtered (dropped)

EVENT=$(cat)
AUTHOR_TYPE=$(echo "$EVENT" | jq -r '.provenance.author_type // "unknown"')

if [[ "$AUTHOR_TYPE" == "bot" ]]; then
    # Drop bot events — empty output
    exit 0
fi

# Pass through
echo "$EVENT"
```

### 3.6 Logger Definition

```yaml
# loggers/default.yaml
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

### 3.7 Plugin Interface Contracts (Installable Components)

OrgLoop has three types of **independently installable packages**: connectors, transforms, and loggers. All three follow the same ecosystem model — publishable to npm, discoverable by convention, loadable at runtime.

| Installable Type | Package Pattern (first-party) | Package Pattern (community) | Interface |
|---|---|---|---|
| **Connectors** | `@orgloop/connector-*` | `orgloop-connector-*` | `SourceConnector`, `ActorConnector` |
| **Transforms** | `@orgloop/transform-*` | `orgloop-transform-*` | `Transform` |
| **Loggers** | `@orgloop/logger-*` | `orgloop-logger-*` | `Logger` |

Sources, actors, and routes are **not** installable — they are declarative YAML config that references installed packages. A source is an *instance* of a connector with specific config. An actor is an *instance* of a target connector. Routes are pure wiring.

All four interfaces below follow the same lifecycle pattern: `init -> work -> shutdown`. The SDK (`@orgloop/sdk`) provides base classes, test harnesses, and scaffold generators for each.

**Package manifest convention:** Installable packages should declare their type in `package.json`:

```json
{
  "orgloop": {
    "type": "connector",
    "provides": ["source", "target"],
    "id": "github"
  }
}
```

This enables `orgloop search connector` to scan npm for compatible packages.

#### Connector Interface (Source)

```typescript
// @orgloop/sdk — SourceConnector interface

import { OrgLoopEvent, SourceConfig } from '@orgloop/sdk';
import { IncomingMessage, ServerResponse } from 'node:http';

export interface SourceConnector {
  /** Unique connector ID */
  readonly id: string;

  /** Initialize with user-provided config */
  init(config: SourceConfig): Promise<void>;

  /**
   * Poll for new events since the last checkpoint.
   * The runtime calls this on the configured interval.
   * Return an array of normalized OrgLoop events.
   */
  poll(checkpoint: string | null): Promise<PollResult>;

  /**
   * Optional: Register a webhook handler.
   * Return a request handler the server will mount.
   * For push-based sources.
   */
  webhook?(): WebhookHandler;

  /** Clean shutdown */
  shutdown(): Promise<void>;
}

export interface PollResult {
  events: OrgLoopEvent[];
  /** Opaque checkpoint string for crash recovery */
  checkpoint: string;
}

export type WebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<OrgLoopEvent[]>;
```

#### Connector Interface (Actor/Target)

```typescript
// @orgloop/sdk — ActorConnector interface

export interface ActorConnector {
  readonly id: string;

  init(config: ActorConfig): Promise<void>;

  /**
   * Deliver an event to this actor.
   * The runtime calls this when a route matches.
   * routeConfig includes actor-specific config from `then.config`
   * plus the resolved launch prompt (if the route has `with`).
   * Return delivery status.
   */
  deliver(event: OrgLoopEvent, routeConfig: RouteDeliveryConfig): Promise<DeliveryResult>;

  shutdown(): Promise<void>;
}

export interface RouteDeliveryConfig {
  /** Actor-specific config from route's `then.config` */
  [key: string]: unknown;
  /** Resolved launch prompt text (from route's `with.prompt_file`) */
  launch_prompt?: string;
  /** Original prompt file path (for reference/logging) */
  launch_prompt_file?: string;
}

export interface DeliveryResult {
  status: 'delivered' | 'rejected' | 'error';
  /** If the actor produces a response event, return it */
  responseEvent?: OrgLoopEvent;
  error?: Error;
}
```

#### Transform Interface (Programmatic)

```typescript
// @orgloop/sdk — Transform interface

export interface Transform {
  readonly id: string;

  init(config: Record<string, unknown>): Promise<void>;

  /**
   * Process an event. Return the (optionally modified) event,
   * or return null to filter/drop the event.
   */
  execute(event: OrgLoopEvent, context: TransformContext): Promise<OrgLoopEvent | null>;

  shutdown(): Promise<void>;
}

export interface TransformContext {
  source: string;
  target: string;
  eventType: string;
  routeName: string;
}
```

#### Logger Interface

```typescript
// @orgloop/sdk — Logger interface

export interface Logger {
  readonly id: string;

  init(config: Record<string, unknown>): Promise<void>;

  /**
   * Called for every pipeline event: source emit, transform result,
   * route match, delivery attempt, delivery result.
   */
  log(entry: LogEntry): Promise<void>;

  /** Flush any buffered entries */
  flush(): Promise<void>;

  shutdown(): Promise<void>;
}

export interface LogEntry {
  timestamp: string;
  event_id: string;
  trace_id: string;
  phase: 'source.emit'
       | 'transform.start' | 'transform.pass' | 'transform.drop' | 'transform.error'
       | 'route.match' | 'route.no_match'
       | 'deliver.attempt' | 'deliver.success' | 'deliver.failure' | 'deliver.retry'
       | 'system.start' | 'system.stop' | 'system.error';
  source?: string;
  target?: string;
  transform?: string;
  route?: string;
  event_type?: string;
  result?: string;
  duration_ms?: number;
  queue_depth?: number;
  error?: string;
  metadata?: Record<string, unknown>;
  orgloop_version?: string;
  hostname?: string;
  workspace?: string;
}
```

#### Connector Registration

Every connector package exports a default registration function. The `setup` property provides onboarding metadata — the CLI uses this to display required environment variables and guide users through external integration steps (e.g., installing hooks, registering webhooks). This is pure metadata; the CLI decides how to act on it.

```typescript
// @orgloop/sdk — ConnectorRegistration interface

export interface ConnectorRegistration {
  id: string;
  source?: new () => SourceConnector;
  target?: new () => ActorConnector;
  configSchema?: Record<string, unknown>;
  /** Onboarding metadata for CLI setup guidance */
  setup?: ConnectorSetup;
}

export interface ConnectorSetup {
  /** Environment variables required by this connector (string or rich definition) */
  env_vars?: (string | EnvVarDefinition)[];
  /** External integration steps (e.g., webhook registration, hook installation) */
  integrations?: ConnectorIntegration[];
}

export interface EnvVarDefinition {
  /** Environment variable name */
  name: string;
  /** Human-readable description of what this var is for */
  description: string;
  /** URL where the user can get/create this credential */
  help_url?: string;
  /** Command to run that helps set up this variable */
  help_command?: string;
  /** Whether this var is required (default: true) */
  required?: boolean;
}

export interface ConnectorIntegration {
  /** Short identifier (e.g., "claude-code-hook", "github-webhook") */
  id: string;
  /** Human-readable description of what needs to be configured */
  description: string;
  /** The tool/platform this integration targets */
  platform: string;
  /** Optional: a command that can automate the setup */
  command?: string;
}
```

**Design note:** `setup` is intentionally generic. Each connector declares what it needs; the CLI has connector-specific knowledge about how to automate certain integrations (e.g., writing to `~/.claude/settings.json` for Claude Code hooks). New platforms don't require SDK changes — they just declare their `integrations` and the CLI can display them even without specific automation support.

### 3.8 Developer Experience

#### Creating a New Connector

```bash
# Scaffold a new connector
$ orgloop add connector my-jira

Created:
  connectors/my-jira/
  ├── src/
  │   ├── index.ts      # Registration + exports
  │   ├── source.ts     # SourceConnector stub
  │   ├── target.ts     # ActorConnector stub (optional)
  │   └── normalizer.ts # Event normalizer stub
  ├── package.json
  ├── tsconfig.json
  └── README.md

Next steps:
  1. Edit connectors/my-jira/src/source.ts to implement polling
  2. Edit connectors/my-jira/src/normalizer.ts to map Jira events → OaC events
  3. Run: orgloop validate
  4. Run: orgloop test --connector my-jira
```

#### Creating a New Transform

```bash
# Shell script transform (simplest)
$ orgloop add transform my-filter --type script

Created: transforms/my-filter.sh

# Package transform (for complex/reusable transforms)
$ orgloop add transform my-enricher --type package

Created:
  transforms/my-enricher/
  ├── src/index.ts
  ├── package.json
  └── README.md
```

#### Creating a New Logger

```bash
$ orgloop add logger my-datadog

Created:
  loggers/my-datadog/
  ├── src/index.ts
  ├── package.json
  └── README.md
```
