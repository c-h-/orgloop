---
title: "Runtime Modes"
description: "Three ways to run OrgLoop — CLI mode, library/SDK mode, and server/API mode — with architecture diagram."
---

### Key Insight: Library-First Architecture

**The core is a library. Everything else is a thin wrapper.**

If `@orgloop/core` is designed as a library first, all three runtime modes come naturally. The CLI is a wrapper that calls the library. The server is a wrapper that exposes the library over HTTP. Users embedding OrgLoop in their own applications import the library directly.

This is the most important architectural decision for long-term flexibility. Don't design a CLI that happens to have a library. Design a library that happens to have a CLI.

```typescript
// The core library — this is the foundation
// Option A: OrgLoop wrapper (single-project convenience API)
import { OrgLoop, OrgLoopConfig, OrgLoopOptions } from '@orgloop/core';

const loop = new OrgLoop(config, {
  sources: sourcesMap,   // Map<string, SourceConnector>
  actors: actorsMap,     // Map<string, ActorConnector>
});
await loop.start();

// Option B: Runtime (full control over lifecycle)
import { Runtime } from '@orgloop/core';

const runtime = new Runtime();
await runtime.start();
await runtime.loadModule(projectConfig, { sources, actors });
// runtime.loadModule() is an internal API — the project config is loaded as a single unit
```

### Mode 1: CLI Mode (MVP)

**Command:** `orgloop start`

For individual developers and small teams. The CLI manages the full lifecycle: load config, start the engine as a long-running daemon, handle signals, manage the PID file. The daemon manages all source polling internally — poll intervals declared in YAML replace external schedulers (LaunchAgents, systemd timers, cron). One OrgLoop process replaces N poller scripts.

Use `orgloop install-service` to generate platform-appropriate service files (LaunchAgent on macOS, systemd unit on Linux, Dockerfile for containers) that keep the daemon alive across reboots.

```bash
# Foreground (development)
orgloop start

# Daemonized (production)
orgloop start --daemon

# System service (production, managed restart)
orgloop service install  # Generates launchd/systemd unit
```

**Who uses this:** Individual developers, small teams, anyone running OrgLoop on a single machine. This is the MVP and the default path.

**Under the hood:**

```typescript
// cli/src/commands/start.ts — simplified
import { Runtime } from '@orgloop/core';
import { loadCliConfig } from '../config';
import { resolveConnectors } from '../resolve-connectors';

const config = await loadCliConfig({ configPath: flags.config });
const { sources, actors } = await resolveConnectors(config);

const runtime = new Runtime();
await runtime.start();
await runtime.startHttpServer();  // Control API + webhook listener
await runtime.loadModule(
  { name: config.project.name, sources: config.sources, actors: config.actors, routes: config.routes, ... },
  { sources, actors }
);
// Runtime is running with the project loaded as a single unit.
```

The CLI creates a `Runtime` instance and loads the project config as a single unit via `runtime.loadModule()` (an internal API). `resolveConnectors()` handles the bridge between declarative YAML config and instantiated connector objects. All runtime logic lives in `@orgloop/core`.

### Mode 2: Library/SDK Mode

**Import:** `import { OrgLoop } from '@orgloop/core'`

For teams building custom tooling or integrating OrgLoop into existing systems. The core is a library — embed it in your own application, hook into its events, extend its behavior programmatically.

```typescript
import { OrgLoop, OrgLoopConfig } from '@orgloop/core';

// Programmatic configuration (not just YAML)
const config: OrgLoopConfig = {
  sources: [{
    id: 'github',
    connector: '@orgloop/connector-github',
    config: { repo: 'my-org/my-repo' },
    poll: { interval: '5m' },
  }],
  actors: [{
    id: 'my-actor',
    connector: '@orgloop/connector-webhook',
    config: { url: 'https://my-service.com/hook' },
  }],
  routes: [{
    name: 'github-to-actor',
    when: { source: 'github', events: ['resource.changed'] },
    then: { actor: 'my-actor' },
  }],
};

const loop = new OrgLoop(config);

// Hook into engine events
loop.on('event', (event) => {
  console.log('Event received:', event.id);
});

loop.on('delivery', (result) => {
  myMetricsSystem.record('orgloop.delivery', result);
});

// Inject events programmatically
loop.inject({
  source: 'custom',
  type: 'resource.changed',
  payload: { /* ... */ },
});

await loop.start();
```

**Who uses this:** Platform teams embedding OrgLoop in a larger system. Internal tools that need event routing as a component, not a standalone daemon. Teams that want programmatic config (not YAML) or custom event sources.

**This mode exists by default** if we design library-first. No additional work needed — just export clean public APIs from `@orgloop/core`.

### Mode 3: Server/API Mode

> **Status:** The runtime includes a built-in HTTP server (default port 4800, configurable via `ORGLOOP_PORT`) that exposes REST API, control API, and webhook endpoints. The `@orgloop/server` package re-exports `@orgloop/core` with `registerRestApi`. No separate `orgloop serve` command is needed — the API is automatically available when the runtime starts.

The HTTP server binds to `127.0.0.1` (localhost only) and starts automatically when the runtime launches. It serves three route families:

#### REST API (GET /api/*)

Observability and monitoring endpoints:

```
GET /api/status     Runtime health, uptime, PID, per-module status, per-source detail
GET /api/routes     All routes with fire counts and last-fired timestamps
GET /api/events     Recent events from ring buffer (query params: from, to, source, route, limit)
GET /api/sources    Per-source connector detail (type, health, event count, poll interval)
GET /api/metrics    Prometheus-format metrics (requires ORGLOOP_METRICS_PORT env var)
```

#### Control API (POST /control/*)

Dynamic module management and lifecycle control:

```
GET  /control/status              Runtime status snapshot
POST /control/module/load         Load a new module: { name, config }
POST /control/module/unload       Unload a module: { name }
POST /control/module/reload       Reload a module: { name }
GET  /control/module/list         List all loaded modules
GET  /control/module/status/:name Status of a specific module
POST /control/shutdown            Graceful runtime shutdown
```

#### Webhook Endpoints (POST /webhook/*)

```
POST /webhook/:sourceId    Receive webhook events for hook-based sources
```

**Who uses this:** The CLI's `orgloop status` command queries `/control/status`. Multi-module daemons use the control API for hot-loading. External tools and dashboards can query `/api/*` for monitoring. Hook-based sources (coding-agent, webhook) receive events via `/webhook/*`.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        @orgloop/core                             │
│                     (THE library — all logic lives here)         │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌────────┐  ┌───────────────────┐ │
│  │ EventBus │  │ Router   │  │ Xforms │  │ Logger Fan-out    │ │
│  │ (WAL)    │  │          │  │        │  │                   │ │
│  └──────────┘  └──────────┘  └────────┘  └───────────────────┘ │
│                                                                  │
│  Public API:                                                     │
│    new OrgLoop(config) — single-project convenience wrapper      │
│    loop.start() / loop.stop() / loop.inject(event)               │
│                                                                  │
│    new Runtime() — full lifecycle control (used by CLI)           │
│    runtime.start() / runtime.stop()                              │
│    runtime.loadModule(config, connectors) — internal API         │
└───────────┬──────────────────────┬───────────────────┬──────────┘
            │                      │                   │
   ┌────────▼────────┐   ┌────────▼────────┐  ┌───────▼────────┐
   │  @orgloop/cli   │   │ @orgloop/server │  │  Your app      │
   │                 │   │                 │  │                │
   │  orgloop start  │   │  Re-exports     │  │  import {      │
   │  orgloop status │   │  core +         │  │    OrgLoop     │
   │  orgloop logs   │   │  registerRestApi│  │  } from core   │
   │  orgloop test   │   │                 │  │                │
   └─────────────────┘   └─────────────────┘  └────────────────┘
        CLI mode           Server/API mode       Library mode
```

### Priority

| Mode | Priority | Notes |
|------|----------|-------|
| CLI mode (`orgloop start`) | **MVP** | Ship first. This proves the core works. |
| Library mode (`import { OrgLoop }`) | **MVP** | Comes free with library-first design. The CLI already uses it. |
| Server mode (built-in HTTP API) | **Implemented** | REST API, control API, and webhook endpoints are built into the runtime. Available on every `orgloop start`. |
