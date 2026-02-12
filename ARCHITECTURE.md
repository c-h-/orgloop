# Architecture

This document describes the OrgLoop codebase structure, how events flow through the system, and how to extend it with new connectors and transforms.

## Repo Structure

```
orgloop/
  packages/
    sdk/          @orgloop/sdk         Type definitions, interfaces, event helpers, test harness
    core/         @orgloop/core        Runtime engine: bus, router, scheduler, transform pipeline, config loader
    cli/          @orgloop/cli         CLI binary (orgloop) — init, validate, plan, start, stop, status, logs, etc.
  connectors/
    github/       @orgloop/connector-github       Source: polls GitHub REST API for PR/issue/CI activity
    linear/       @orgloop/connector-linear       Source: polls Linear GraphQL API for issue/comment updates
    claude-code/  @orgloop/connector-claude-code  Source: receives Claude Code session exits via webhook
    openclaw/     @orgloop/connector-openclaw     Target: delivers events to OpenClaw agents via HTTP
    webhook/      @orgloop/connector-webhook      Source + Target: generic inbound/outbound webhook
  transforms/
    filter/       @orgloop/transform-filter       Filters events by field matching or jq expressions
    dedup/        @orgloop/transform-dedup        Deduplicates events within a time window
  loggers/
    console/      @orgloop/logger-console         Human-readable colored console output
    file/         @orgloop/logger-file            JSONL file logger with rotation
  routes/                             Route YAML files (when/then/with wiring)
  docs/                               Specs, manifesto, CLI walkthrough
  examples/                           Example configurations (minimal, production)
```

## Dependency Graph

All packages are published under `@orgloop/*`. The dependency chain flows in one direction:

```
@orgloop/sdk                   (zero runtime deps — pure types + helpers)
    ^
    |
@orgloop/core                  (depends on sdk — engine, bus, router, scheduler)
    ^
    |
@orgloop/cli                   (depends on sdk + core — the orgloop binary)

connectors/*   ──> @orgloop/sdk    (each connector depends only on sdk)
transforms/*   ──> @orgloop/sdk    (each transform depends only on sdk)
loggers/*      ──> @orgloop/sdk    (each logger depends only on sdk)
```

The SDK is the shared contract. Connectors, transforms, and loggers never import from `@orgloop/core` -- they only implement SDK interfaces. The core engine loads and orchestrates them at runtime.

## Build System

- **pnpm workspaces** with four workspace roots: `packages/*`, `connectors/*`, `transforms/*`, `loggers/*`
- **Turborepo** for task orchestration (`turbo.json`). The `build` task uses `dependsOn: ["^build"]` so SDK builds before core, core before CLI, etc.
- **TypeScript** with a shared `tsconfig.base.json`
- **Vitest** for testing, **Biome** for linting and formatting
- **Node >= 22** required (see root `package.json` engines field)

Key commands:
```bash
pnpm build        # build all packages (via turbo)
pnpm test         # run all tests
pnpm lint         # biome check
pnpm typecheck    # tsc --noEmit across all packages
```

## Runtime Architecture

The `Runtime` class owns shared infrastructure: EventBus, Scheduler, LoggerManager, WebhookServer, and ModuleRegistry. Each `ModuleInstance` owns per-module resources (sources, actors, routes, transforms) and has an independent lifecycle: `loading` -> `active` -> `unloading` -> `removed`.

The `OrgLoop` class is a backward-compatible wrapper that creates a single "default" module inside a Runtime, preserving the original single-module API.

The CLI's `orgloop start` creates a `Runtime` and calls `loadModule()` for each configured module. The HTTP control API (`/control/module/*`) enables dynamic module management at runtime.

## How an Event Flows

This is the end-to-end path of a single event through the system:

```
1. Source poll / webhook
       |
       v
2. Connector normalizes raw data into OrgLoopEvent (buildEvent)
       |
       v
3. ModuleInstance receives PollResult.events
       |
       v
4. Each event is enriched with a trace_id
       |
       v
5. Event published to EventBus (InMemoryBus or FileWalBus)
       |
       v
6. Module-scoped router matches event against the module's route definitions
   (source match + event type match + optional filter)
       |
       v
7. For each matched route:
   a. Transform pipeline runs (filter, dedup, custom transforms)
      - Transforms return the event (pass), a modified event, or null (drop)
      - Pipeline is fail-open: transform errors pass the event through
   b. If event survives transforms:
      - Engine resolves launch prompt (reads with.prompt_file)
      - Actor.deliver() is called with the event + route delivery config
       |
       v
8. Event is acked on the bus after all matched routes are processed
       |
       v
9. Structured LogEntry emitted at each phase (source.emit, route.match,
   transform.pass/drop, deliver.attempt/success/failure)
```

### Key types in the flow

| Step | Type | Defined in |
|------|------|-----------|
| Event | `OrgLoopEvent` | `packages/sdk/src/types.ts` |
| Poll result | `PollResult` | `packages/sdk/src/connector.ts` |
| Route match | `MatchedRoute` | `packages/core/src/router.ts` |
| Transform result | `OrgLoopEvent \| null` | `packages/sdk/src/transform.ts` |
| Delivery result | `DeliveryResult` | `packages/sdk/src/connector.ts` |
| Log entry | `LogEntry` | `packages/sdk/src/types.ts` |

## How to Add a Connector

1. **Create the package directory:**

   ```bash
   mkdir -p connectors/my-service/src
   ```

2. **Create `package.json`:**

   ```json
   {
     "name": "@orgloop/connector-my-service",
     "version": "0.1.0",
     "type": "module",
     "main": "dist/index.js",
     "types": "dist/index.d.ts",
     "dependencies": {
       "@orgloop/sdk": "workspace:*"
     },
     "orgloop": {
       "type": "connector",
       "provides": ["source"],
       "id": "my-service"
     }
   }
   ```

   Set `provides` to `["source"]`, `["target"]`, or `["source", "target"]`.

3. **Implement the connector class.**

   For a source, implement `SourceConnector` from `@orgloop/sdk`:

   ```typescript
   // connectors/my-service/src/source.ts
   import type { SourceConnector, SourceConfig, PollResult } from '@orgloop/sdk';
   import { buildEvent } from '@orgloop/sdk';

   export class MyServiceSource implements SourceConnector {
     readonly id = 'my-service';

     async init(config: SourceConfig): Promise<void> {
       // Parse config, create API client
     }

     async poll(checkpoint: string | null): Promise<PollResult> {
       // Fetch new data since checkpoint
       // Normalize to OrgLoopEvent using buildEvent()
       // Return { events, checkpoint }
     }

     async shutdown(): Promise<void> {
       // Clean up
     }
   }
   ```

   For a target, implement `ActorConnector`:

   ```typescript
   import type { ActorConnector, ActorConfig, DeliveryResult, OrgLoopEvent, RouteDeliveryConfig } from '@orgloop/sdk';

   export class MyServiceTarget implements ActorConnector {
     readonly id = 'my-service';

     async init(config: ActorConfig): Promise<void> { /* ... */ }

     async deliver(event: OrgLoopEvent, routeConfig: RouteDeliveryConfig): Promise<DeliveryResult> {
       // Send event to external system
       return { status: 'delivered' };
     }

     async shutdown(): Promise<void> { /* ... */ }
   }
   ```

4. **Create the registration entry point:**

   ```typescript
   // connectors/my-service/src/index.ts
   import type { ConnectorRegistration } from '@orgloop/sdk';
   import { MyServiceSource } from './source.js';

   export default function register(): ConnectorRegistration {
     return {
       id: 'my-service',
       source: MyServiceSource,
     };
   }
   ```

5. **Add a `tsconfig.json`** extending the base config and add build scripts.

6. **Write tests** using the SDK test harness (`createTestEvent`, `createTestContext`).

## How to Add a Transform

1. **Create the package directory:**

   ```bash
   mkdir -p transforms/my-transform/src
   ```

2. **Create `package.json`:**

   ```json
   {
     "name": "@orgloop/transform-my-transform",
     "version": "0.1.0",
     "type": "module",
     "main": "dist/index.js",
     "types": "dist/index.d.ts",
     "dependencies": {
       "@orgloop/sdk": "workspace:*"
     },
     "orgloop": {
       "type": "transform",
       "id": "my-transform"
     }
   }
   ```

3. **Implement the `Transform` interface:**

   ```typescript
   // transforms/my-transform/src/my-transform.ts
   import type { OrgLoopEvent, Transform, TransformContext } from '@orgloop/sdk';

   export class MyTransform implements Transform {
     readonly id = 'my-transform';

     async init(config: Record<string, unknown>): Promise<void> {
       // Parse and store config
     }

     async execute(event: OrgLoopEvent, context: TransformContext): Promise<OrgLoopEvent | null> {
       // Return the event to pass it through (optionally modified)
       // Return null to drop it
     }

     async shutdown(): Promise<void> {
       // Clean up resources
     }
   }
   ```

4. **Create the registration entry point:**

   ```typescript
   // transforms/my-transform/src/index.ts
   import type { TransformRegistration } from '@orgloop/sdk';
   import { MyTransform } from './my-transform.js';

   export function register(): TransformRegistration {
     return {
       id: 'my-transform',
       transform: MyTransform,
       configSchema: { /* optional JSON Schema */ },
     };
   }
   ```

5. **Alternatively, use a script transform** (no package needed). Create a shell script that reads JSON from stdin and writes modified JSON to stdout:

   ```yaml
   transforms:
     - name: my-script
       type: script
       script: ./scripts/my-transform.sh
   ```

   Exit codes: `0` = success, `1` = drop event, `>= 2` = error (fail-open, event passes through).

## Key Files

Start reading here to understand the system:

| File | What it does |
|------|-------------|
| `packages/sdk/src/types.ts` | All core type definitions (`OrgLoopEvent`, config types, log types) |
| `packages/sdk/src/connector.ts` | `SourceConnector` and `ActorConnector` interfaces |
| `packages/sdk/src/transform.ts` | `Transform` interface |
| `packages/sdk/src/event.ts` | `buildEvent()` helper, event validation |
| `packages/core/src/runtime.ts` | `Runtime` class -- multi-module runtime, owns shared infrastructure |
| `packages/core/src/module-instance.ts` | `ModuleInstance` class -- per-module resource container and lifecycle |
| `packages/core/src/registry.ts` | `ModuleRegistry` -- singleton module name registry |
| `packages/core/src/engine.ts` | `OrgLoop` class -- backward-compatible wrapper around Runtime |
| `packages/core/src/router.ts` | Route matching logic |
| `packages/core/src/transform.ts` | Transform pipeline executor (script + package) |
| `packages/core/src/bus.ts` | Event bus (InMemoryBus, FileWalBus) |
| `packages/core/src/store.ts` | Checkpoint store + WAL event store |
| `packages/core/src/scheduler.ts` | Poll scheduling (setInterval-based) |
| `packages/core/src/schema.ts` | YAML config loader + JSON Schema validation |
| `packages/cli/src/index.ts` | CLI entry point, command registration |
| `packages/cli/src/commands/start.ts` | `orgloop start` -- the main "start engine" command |
