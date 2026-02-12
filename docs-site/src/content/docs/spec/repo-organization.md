---
title: "Repository Organization"
description: "Monorepo structure, directory layout, and first-party vs. community package conventions."
---

### Decision: Monorepo with Workspace Packages

OrgLoop uses a single monorepo with workspace-scoped packages. This is the right choice at this stage for three reasons:

1. **Atomic changes.** A connector interface change + connector update + CLI update ships as one commit.
2. **Shared tooling.** One CI pipeline, one lint config, one test harness.
3. **Low overhead.** We're a small team. Multi-repo coordination costs dominate at our scale.

When the community grows and third-party connectors proliferate, community connectors live in their own repos (like Terraform providers). First-party connectors stay in the monorepo.

### Directory Structure

```
orgloop/
├── DESIGN.md                    # Architecture and philosophy
├── README.md                    # Project overview + quickstart
├── AGENTS.md                    # AI agent guidance
├── CLAUDE.md                    # Claude Code project instructions
├── LICENSE                      # Apache 2.0
├── package.json                 # Workspace root (pnpm workspaces)
├── pnpm-workspace.yaml
├── tsconfig.base.json           # Shared TypeScript config
├── turbo.json                   # Turborepo build orchestration
│
├── packages/
│   ├── core/                    # @orgloop/core — runtime engine
│   │   └── src/
│   │       ├── runtime.ts       # Runtime: long-lived host process (bus, scheduler, loggers, registry)
│   │       ├── module-instance.ts # ModuleInstance: per-module resources and lifecycle
│   │       ├── registry.ts      # ModuleRegistry: name → instance mapping, singleton enforcement
│   │       ├── engine.ts        # OrgLoop: backward-compatible wrapper around Runtime
│   │       ├── router.ts        # Route matching + dispatch
│   │       ├── transform.ts     # Transform pipeline executor
│   │       ├── logger.ts        # Logger fan-out manager
│   │       ├── bus.ts           # EventBus (InMemoryBus, FileWalBus)
│   │       ├── store.ts         # Checkpoint + event store
│   │       ├── scheduler.ts     # Poll scheduling + cron
│   │       ├── http.ts          # Webhook HTTP server (localhost:4800) + control API
│   │       ├── schema.ts        # YAML schema validation (JSON Schema / AJV)
│   │       └── errors.ts        # Error taxonomy
│   │
│   ├── cli/                     # @orgloop/cli — command-line interface
│   │   └── src/
│   │       ├── index.ts         # Entry point
│   │       ├── commands/        # One file per command
│   │       │   ├── init.ts
│   │       │   ├── validate.ts
│   │       │   ├── plan.ts
│   │       │   ├── start.ts
│   │       │   ├── stop.ts
│   │       │   ├── status.ts
│   │       │   ├── logs.ts
│   │       │   ├── test.ts
│   │       │   ├── add.ts
│   │       │   ├── env.ts
│   │       │   ├── doctor.ts
│   │       │   ├── routes.ts
│   │       │   ├── hook.ts
│   │       │   ├── module.ts
│   │       │   ├── inspect.ts
│   │       │   ├── install-service.ts
│   │       │   ├── service.ts
│   │       │   └── version.ts
│   │       └── output.ts        # Formatting, colors, tables
│   │
│   ├── sdk/                     # @orgloop/sdk — plugin development kit
│   │   └── src/
│   │       ├── types.ts         # Core type definitions (OrgLoopEvent, config, etc.)
│   │       ├── connector.ts     # Connector interfaces (Source, Actor, Registration)
│   │       ├── transform.ts     # Transform interface + context
│   │       ├── logger.ts        # Logger interface + registration
│   │       ├── event.ts         # Event builder + validators
│   │       ├── module.ts        # Module manifest types + template expansion
│   │       └── testing.ts       # Test harness for plugin authors
│   │
│   └── server/                  # @orgloop/server — HTTP API server (placeholder)
│       └── src/
│           └── index.ts         # Re-exports @orgloop/core (v1.1 scope)
│
├── connectors/                  # First-party connectors
│   ├── github/                  # @orgloop/connector-github
│   │   └── src/
│   │       ├── index.ts         # Connector registration
│   │       ├── source.ts        # GitHub source (poll-based)
│   │       ├── normalizer.ts    # GitHub events → OrgLoop event types
│   │       └── validator.ts     # Credential validation
│   │
│   ├── linear/                  # @orgloop/connector-linear
│   │   └── src/
│   │       ├── index.ts
│   │       ├── source.ts        # Linear source (GraphQL poll)
│   │       ├── normalizer.ts    # Linear events → OrgLoop event types
│   │       └── validator.ts     # Credential validation
│   │
│   ├── openclaw/                # @orgloop/connector-openclaw
│   │   └── src/
│   │       ├── index.ts
│   │       ├── target.ts        # Wake agents via webhook API
│   │       ├── detector.ts      # Service detection (health check)
│   │       └── validator.ts     # Credential validation
│   │
│   ├── claude-code/             # @orgloop/connector-claude-code
│   │   └── src/
│   │       ├── index.ts
│   │       ├── source.ts        # Webhook receiver for exit hooks
│   │       └── hook.sh          # Shell hook script
│   │
│   ├── cron/                    # @orgloop/connector-cron
│   │   └── src/
│   │       ├── index.ts
│   │       └── source.ts        # Cron-based event emission
│   │
│   └── webhook/                 # @orgloop/connector-webhook
│       └── src/
│           ├── index.ts
│           ├── source.ts        # Generic inbound webhook receiver
│           └── target.ts        # Generic outbound webhook sender
│
├── transforms/                  # First-party transforms
│   ├── filter/                  # @orgloop/transform-filter (match/exclude + jq)
│   └── dedup/                   # @orgloop/transform-dedup (SHA-256, time window)
│
├── loggers/                     # First-party loggers
│   ├── file/                    # @orgloop/logger-file (buffered JSONL, rotation)
│   └── console/                 # @orgloop/logger-console (ANSI colors, phase icons)
│
├── modules/                     # First-party modules (workflow bundles)
│   ├── engineering/             # @orgloop/module-engineering
│   │   ├── orgloop-module.yaml  # Module manifest
│   │   ├── connectors/          # Connector config templates
│   │   ├── templates/           # Route templates (parameterized)
│   │   └── transforms/          # Transform config
│   └── minimal/                 # @orgloop/module-minimal
│       ├── orgloop-module.yaml
│       ├── connectors/
│       └── templates/
│
├── docs-site/                   # Documentation (Astro Starlight)
│
└── examples/                    # Example configurations
    ├── minimal/                 # Simplest possible setup
    ├── engineering-org/         # Full engineering org
    ├── github-to-slack/         # Single source → single actor
    ├── multi-agent-supervisor/  # Claude Code supervision pattern
    └── production/              # Production config example
```

### First-Party vs. Community Packages

| Aspect | First-Party | Community |
|--------|-------------|-----------|
| Location | Monorepo (`connectors/`, `transforms/`, `loggers/`, `modules/`) | Separate repos |
| npm scope | `@orgloop/connector-*`, `@orgloop/transform-*`, `@orgloop/logger-*`, `@orgloop/module-*` | `orgloop-connector-*`, `orgloop-transform-*`, `orgloop-logger-*`, `orgloop-module-*` |
| Versioned with | Core runtime | Independently |
| CI | Monorepo CI | Connector author's CI |
| Compatibility | Guaranteed with current core | Declares `@orgloop/sdk` peer dependency |
| Approval required | N/A (we publish them) | **None** — anyone can publish at any time |

**Inspiration:** Terraform's provider model. `hashicorp/aws` is first-party; community providers follow a naming convention, implement a well-defined interface, and are discovered via registry/npm. See [Zero Bottleneck to Adoption](#24-design-principle-zero-bottleneck-to-adoption) for the full philosophy.
