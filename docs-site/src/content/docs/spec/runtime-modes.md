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

### Mode 3: Server/API Mode (v1.1 -- Not Yet Implemented)

> **Status:** `@orgloop/server` exists as a placeholder package that re-exports `@orgloop/core`. The REST API, `orgloop serve` command, and HTTP layer described below are the planned v1.1 design. No `serve` CLI command exists today.

**Planned command:** `orgloop serve`

Will expose a REST API for programmatic control, event ingestion, and status monitoring. For production deployments, web dashboards, and enterprise integrations.

Note: The engine already has a lightweight `WebhookServer` (localhost-only, port 4800) for hook-based sources like Claude Code. The server mode described here is a full-featured API server — a separate concern.

#### Planned API Surface

```
# Event ingestion (push-based sources)
POST   /api/v1/events              Ingest an event
GET    /api/v1/events              Query recent events (with filters)
GET    /api/v1/events/:id          Get a specific event's full trace

# Runtime management
GET    /api/v1/status              Runtime status (uptime, counts)
GET    /api/v1/health              Health check (for load balancers)

# Observability
GET    /api/v1/sources             List sources and their status
GET    /api/v1/sources/:id         Source detail (checkpoint, stats)
GET    /api/v1/actors              List actors and their status
GET    /api/v1/actors/:id          Actor detail (delivery stats)
GET    /api/v1/routes              List routes and their stats
GET    /api/v1/routes/:id          Route detail (match/drop counts)

# Configuration management
POST   /api/v1/config/validate     Validate a config payload
POST   /api/v1/config/plan         Compute a plan
POST   /api/v1/config/start        Apply a config change

# Logs
GET    /api/v1/logs                Stream logs (SSE)
GET    /api/v1/logs/query          Query historical logs

# Webhook receiver (for push-based sources)
POST   /api/v1/webhooks/:source    Receive webhook from a source platform
```

**Who will use this:** Production deployments behind a load balancer. Web dashboards that show OrgLoop status. Enterprise integrations that need programmatic event ingestion. Teams that want an API-first interface instead of (or in addition to) CLI.

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
   │                 │   │  (placeholder)  │  │                │
   │  orgloop start  │   │                 │  │  import {      │
   │  orgloop status │   │  orgloop serve  │  │    OrgLoop     │
   │  orgloop logs   │   │  REST API       │  │  } from core   │
   │  orgloop test   │   │  (v1.1)         │  │                │
   └─────────────────┘   └─────────────────┘  └────────────────┘
        CLI mode           Server mode (v1.1)    Library mode
```

### Priority

| Mode | Priority | Notes |
|------|----------|-------|
| CLI mode (`orgloop start`) | **MVP** | Ship first. This proves the core works. |
| Library mode (`import { OrgLoop }`) | **MVP** | Comes free with library-first design. The CLI already uses it. |
| Server mode (`orgloop serve`) | **v1.1** | After CLI is proven, add the HTTP layer. The library API is already there; server is just HTTP routing on top. |
