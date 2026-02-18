---
title: Architecture
description: How OrgLoop is built — monorepo structure, event flow, and plugin system.
---

OrgLoop is a TypeScript monorepo built with pnpm workspaces and Turborepo. This page covers the internal architecture for developers who want to understand how the pieces fit together.

## Monorepo Structure

```
orgloop/
  packages/
    sdk/          @orgloop/sdk              Types, interfaces, test harness
    core/         @orgloop/core             Engine, bus, router, scheduler, config
    cli/          @orgloop/cli              The `orgloop` CLI binary
    server/       @orgloop/server           HTTP API server (placeholder)

  connectors/
    github/       @orgloop/connector-github          Poll: GitHub REST API
    linear/       @orgloop/connector-linear           Poll: Linear GraphQL API
    claude-code/  @orgloop/connector-claude-code      Hook: session exit receiver
    openclaw/     @orgloop/connector-openclaw          Target: delivers to OpenClaw agents
    webhook/      @orgloop/connector-webhook           Generic HTTP source + target
    cron/         @orgloop/connector-cron              Scheduled: cron + interval syntax
    agent-ctl/    @orgloop/connector-agent-ctl        Poll: AI agent session lifecycle
    docker/       @orgloop/connector-docker            Target: Docker container + Kind cluster control
    gog/          @orgloop/connector-gog               Poll: Gmail via gog CLI

  transforms/
    filter/       @orgloop/transform-filter           Match/exclude by field patterns
    dedup/        @orgloop/transform-dedup            SHA-256 hash, time window
    enrich/       @orgloop/transform-enrich           Add, copy, and compute fields
    agent-gate/   @orgloop/transform-agent-gate       Gate events on running agent sessions

  loggers/
    console/      @orgloop/logger-console             ANSI colors, phase icons
    file/         @orgloop/logger-file                Buffered JSONL, rotation, gzip
    otel/         @orgloop/logger-otel                OpenTelemetry OTLP export
    syslog/       @orgloop/logger-syslog              RFC 5424 syslog protocol
```

## Dependency Chain

Dependencies flow in one direction. The SDK is the shared contract.

```
@orgloop/sdk                   (zero runtime deps -- pure types + helpers)
    ^
    |
@orgloop/core                  (depends on sdk -- engine, bus, router, scheduler)
    ^
    |
@orgloop/cli                   (depends on sdk + core -- the orgloop binary)

connectors/*   --> @orgloop/sdk    (each connector depends only on sdk)
transforms/*   --> @orgloop/sdk    (each transform depends only on sdk)
loggers/*      --> @orgloop/sdk    (each logger depends only on sdk)
```

Connectors, transforms, and loggers never import from `@orgloop/core`. They implement SDK interfaces. The core engine loads and orchestrates them at runtime.

## Build System

| Tool | Role |
|------|------|
| **pnpm** (>= 9) | Package management, workspace linking |
| **Turborepo** | Build orchestration. `dependsOn: ["^build"]` ensures SDK builds before core, core before CLI. |
| **TypeScript** | Strict mode, pure ESM (`"type": "module"`, `verbatimModuleSyntax: true`) |
| **Vitest** | Test runner, globals enabled |
| **Biome** | Linting and formatting (tabs, single quotes, semicolons) |
| **Node >= 22** | Runtime requirement |

```bash
pnpm build        # Build all packages (via turbo)
pnpm test         # Run all tests
pnpm lint         # Biome check
pnpm typecheck    # tsc --noEmit across all packages
```

## Event Flow

The `Runtime` owns the shared infrastructure (bus, scheduler, loggers, HTTP server) and manages sources, actors, routes, and transforms loaded from your project config.

The end-to-end path of a single event through the system:

```
1. Source.poll() or webhook receives raw data
       |
       v
2. Connector normalizes raw data into OrgLoopEvent
       |
       v
3. Runtime receives PollResult.events
       |
       v
4. Event enriched with trace_id (trc_ prefix)
       |
       v
5. Event published to EventBus
       |
       v
6. matchRoutes() matches event against all route definitions
   (source match + event type match + optional filter)
       |
       v
7. For each matched route:
   a. executeTransformPipeline() runs transforms sequentially
      - Returns event (pass), modified event, or null (drop)
      - Fail-open: transform errors pass the event through
   b. If event survives transforms:
      - Engine resolves launch prompt (reads with.prompt_file)
      - Actor.deliver() called with event + route config
       |
       v
8. If actor type emits completion events:
   actor.stopped --> published back to EventBus (the loop)
       |
       v
9. LogEntry emitted at each phase (source, transform, route, deliver)
```

The bus is the spine. Routes are explicit allow-lists -- actors only see events their routes match.

## Key Classes

| Class | File | Role |
|-------|------|------|
| `Runtime` | `packages/core/src/runtime.ts` | Core runtime. Owns bus, scheduler, loggers, HTTP control server. |
| `OrgLoop` | `packages/core/src/engine.ts` | Convenience wrapper around Runtime for single-project use. |
| `matchRoutes()` | `packages/core/src/router.ts` | Dot-path filtering, multi-route matching. Returns all routes an event matches. |
| `executeTransformPipeline()` | `packages/core/src/transform.ts` | Runs transforms sequentially. Fail-open default. |
| `Scheduler` | `packages/core/src/scheduler.ts` | Manages poll intervals for all sources. Graceful start/stop. |
| `InMemoryBus` | `packages/core/src/bus.ts` | Default event bus. Fast, no persistence. |
| `FileWalBus` | `packages/core/src/bus.ts` | Write-ahead log event bus. Survives crashes. |
| `loadConfig()` | `packages/core/src/schema.ts` | YAML loading, AJV schema validation, env var substitution. |
| `FileCheckpointStore` | `packages/core/src/store.ts` | Persists source polling checkpoints. Enables resume after restart. |
| `LoggerManager` | `packages/core/src/logger.ts` | Fan-out to all registered loggers. Non-blocking, error-isolated. |

## Key Types

| Type | Defined In | Purpose |
|------|-----------|---------|
| `OrgLoopEvent` | `packages/sdk/src/types.ts` | Core event envelope (id, timestamp, source, type, provenance, payload, trace_id) |
| `PollResult` | `packages/sdk/src/connector.ts` | What sources return from polling: `{ events, checkpoint }` |
| `MatchedRoute` | `packages/core/src/router.ts` | Route matching result with resolved config |
| `DeliveryResult` | `packages/sdk/src/connector.ts` | What actors return from delivery: `{ success, error? }` |
| `LogEntry` | `packages/sdk/src/types.ts` | Structured log output with phase, event ID, result |

## Plugin Registration

Every connector, transform, and logger exports a `register()` function that returns a registration object:

```typescript
// Connector registration
interface ConnectorRegistration {
  id: string;
  source?: SourceConnectorFactory;
  target?: ActorConnectorFactory;
  configSchema?: JSONSchema;
  setup?: ConnectorSetup;
}

// Transform registration
interface TransformRegistration {
  id: string;
  transform: TransformFactory;
  configSchema?: JSONSchema;
}

// Logger registration
interface LoggerRegistration {
  id: string;
  logger: LoggerFactory;
  configSchema?: JSONSchema;
}
```

The CLI dynamically imports packages and calls `register()` during `orgloop start`. The returned instances are passed to the runtime for initialization.

### Plugin Wiring Chain

Every plugin must be wired through the full chain. Missing any step causes silent failure at runtime.

```
1. package.json dep        -- project must list the package as a dependency
2. Dynamic import          -- start.ts imports the package and calls register()
3. Runtime loading         -- resolved instance passed to the runtime
4. Plugin init             -- init() called with config from YAML
```

## Config Loading Pipeline

```
YAML files on disk
       |
       v
loadConfig() parses YAML
       |
       v
AJV validates against JSON Schema
       |
       v
${VAR_NAME} patterns substituted with env var values
       |
       v
Fully resolved config passed to engine
```

Relative paths in YAML resolve relative to the file containing them, not the project root.

## Runtime Modes

OrgLoop supports three runtime modes:

| Mode | Entry Point | Use Case |
|------|-------------|----------|
| **CLI** | `orgloop start` | Primary. Interactive, daemon, and supervised daemon modes. |
| **Library** | `import { Runtime } from '@orgloop/core'` | Programmatic embedding. |
| **Server** | `orgloop serve` / `@orgloop/server` | HTTP API for remote control (placeholder). |

The CLI is the primary interface. The library mode exposes the `Runtime` class (or the `OrgLoop` wrapper) for programmatic use. The server mode wraps the runtime with an HTTP API.

## Further Reading

- [Five Primitives](/concepts/five-primitives/) -- the building blocks
- [Event Taxonomy](/concepts/event-taxonomy/) -- the three event types
- [Building Connectors](/guides/connector-authoring/) -- implement a source or target
- [Building Transforms](/guides/transform-authoring/) -- implement a transform
- Source code: [github.com/c-h-/orgloop](https://github.com/c-h-/orgloop)
