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
├── README.md                    # Project overview + quickstart
├── AGENTS.md                    # AI agent guidance
├── CLAUDE.md                    # Claude Code project instructions
├── LICENSE.md                   # MIT License
├── package.json                 # Workspace root (pnpm workspaces)
├── pnpm-workspace.yaml
├── tsconfig.base.json           # Shared TypeScript config
├── turbo.json                   # Turborepo build orchestration
│
├── packages/
│   ├── core/                    # @orgloop/core — runtime engine
│   │   └── src/
│   │       ├── runtime.ts       # Runtime: long-lived host process (bus, scheduler, loggers, registry)
│   │       ├── module-instance.ts # ModuleInstance: internal workload container (project loaded as single instance)
│   │       ├── registry.ts      # ModuleRegistry: internal name → instance mapping
│   │       ├── engine.ts        # OrgLoop: single-project convenience wrapper around Runtime
│   │       ├── router.ts        # Route matching + dispatch
│   │       ├── transform.ts     # Transform pipeline executor
│   │       ├── logger.ts        # Logger fan-out manager
│   │       ├── bus.ts           # EventBus (InMemoryBus, FileWalBus)
│   │       ├── store.ts         # Checkpoint + event store
│   │       ├── scheduler.ts     # Poll scheduling + cron
│   │       ├── http.ts          # Webhook HTTP server (localhost:4800) + control API
│   │       ├── rest-api.ts      # REST API endpoints (/api/status, /api/routes, /api/events, /api/sources, /api/metrics)
│   │       ├── event-history.ts # Ring buffer for recent event storage
│   │       ├── metrics.ts       # Prometheus metrics collection
│   │       ├── supervisor.ts    # Daemon supervisor (auto-restart on crash)
│   │       ├── prompt.ts        # Launch prompt file loading (YAML front matter stripping)
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
│   │       │   ├── inspect.ts
│   │       │   ├── install-service.ts
│   │       │   ├── service.ts
│   │       │   └── version.ts
│   │       └── output.ts        # Formatting, colors, tables
│   │
│   ├── sdk/                     # @orgloop/sdk — plugin development kit
│   │   └── src/
│   │       ├── index.ts         # Barrel export (re-exports all modules)
│   │       ├── types.ts         # Core type definitions (OrgLoopEvent, config, etc.)
│   │       ├── connector.ts     # Connector interfaces (Source, Actor, Registration)
│   │       ├── transform.ts     # Transform interface + context
│   │       ├── logger.ts        # Logger interface + registration
│   │       ├── event.ts         # Event builder + validators
│   │       ├── http.ts          # HTTP client utilities (keep-alive, fetch wrapper)
│   │       ├── lifecycle.ts     # Normalized lifecycle contract types + validators
│   │       └── testing.ts       # Test harness for plugin authors
│   │
│   └── server/                  # @orgloop/server — HTTP API server
│       └── src/
│           └── index.ts         # Re-exports @orgloop/core + registerRestApi
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
│   ├── coding-agent/            # @orgloop/connector-coding-agent
│   │   └── src/
│   │       ├── index.ts         # Connector registration
│   │       └── source.ts        # Harness-agnostic webhook receiver (normalized lifecycle)
│   │
│   ├── claude-code/             # @orgloop/connector-claude-code (backward-compat alias)
│   │   └── src/
│   │       ├── index.ts         # Re-exports coding-agent with claude-code ID
│   │       └── source.ts        # Re-exports CodingAgentSource
│   │
│   ├── codex/                   # @orgloop/connector-codex
│   │   └── src/                 # Hook: Codex session lifecycle (delegates to coding-agent)
│   │
│   ├── opencode/                # @orgloop/connector-opencode
│   │   └── src/                 # Hook: OpenCode session lifecycle (delegates to coding-agent)
│   │
│   ├── pi/                      # @orgloop/connector-pi
│   │   └── src/                 # Hook: Pi session lifecycle (delegates to coding-agent)
│   │
│   ├── pi-rust/                 # @orgloop/connector-pi-rust
│   │   └── src/                 # Hook: Pi-rust session lifecycle (delegates to coding-agent)
│   │
│   ├── cron/                    # @orgloop/connector-cron
│   │   └── src/
│   │       ├── index.ts
│   │       └── source.ts        # Cron-based event emission
│   │
│   ├── webhook/                 # @orgloop/connector-webhook
│   │   └── src/
│   │       ├── index.ts
│   │       ├── source.ts        # Generic inbound webhook receiver
│   │       └── target.ts        # Generic outbound webhook sender
│   │
│   ├── agent-ctl/               # @orgloop/connector-agent-ctl
│   │   └── src/                 # Poll: AI agent session lifecycle events
│   │
│   ├── docker/                  # @orgloop/connector-docker
│   │   └── src/                 # Target: Docker container + Kind cluster control
│   │
│   └── gog/                     # @orgloop/connector-gog
│       └── src/                 # Poll: Gmail via gog CLI
│
├── transforms/                  # First-party transforms
│   ├── filter/                  # @orgloop/transform-filter (match/exclude + jq)
│   ├── dedup/                   # @orgloop/transform-dedup (SHA-256, time window)
│   ├── enrich/                  # @orgloop/transform-enrich (add, copy, compute fields)
│   └── agent-gate/              # @orgloop/transform-agent-gate (gate on running agents)
│
├── loggers/                     # First-party loggers
│   ├── file/                    # @orgloop/logger-file (buffered JSONL, rotation)
│   ├── console/                 # @orgloop/logger-console (ANSI colors, phase icons)
│   ├── otel/                    # @orgloop/logger-otel (OpenTelemetry OTLP export)
│   └── syslog/                  # @orgloop/logger-syslog (RFC 5424 syslog protocol)
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
| Location | Monorepo (`connectors/`, `transforms/`, `loggers/`) | Separate repos |
| npm scope | `@orgloop/connector-*`, `@orgloop/transform-*`, `@orgloop/logger-*` | `orgloop-connector-*`, `orgloop-transform-*`, `orgloop-logger-*` |
| Versioned with | Core runtime | Independently |
| CI | Monorepo CI | Connector author's CI |
| Compatibility | Guaranteed with current core | Declares `@orgloop/sdk` peer dependency |
| Approval required | N/A (we publish them) | **None** — anyone can publish at any time |

**Inspiration:** Terraform's provider model. `hashicorp/aws` is first-party; community providers follow a naming convention, implement a well-defined interface, and are discovered via registry/npm. No approval needed — if it implements the interface, it works.
