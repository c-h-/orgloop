---
title: "Runtime Lifecycle"
description: "Runtime as a long-lived host process, project loading, daemon and supervised daemon modes, signal handling, state management, and the path to networked runtimes."
---

> **Status: Implemented.** The runtime architecture is implemented in `packages/core/src/runtime.ts`, `packages/core/src/module-instance.ts`, and `packages/core/src/registry.ts`. The CLI operates in single-project mode -- `orgloop start` loads your project config into the runtime. Daemon mode (`--daemon`) and supervised daemon mode (`--daemon --supervised`) are implemented.

### Core Insight: Separate the Runtime from the Workload

OrgLoop separates two concerns:

1. **Runtime infrastructure** -- the event bus, scheduler, logger fanout, checkpoint store, HTTP listener
2. **Workloads** -- the sources, routes, transforms, and actors that do actual work

The runtime is long-lived infrastructure. Workloads are the project's configuration -- sources, routes, transforms, and actors defined in YAML. The runtime owns the shared infrastructure; the project config defines what work flows through it.

### Runtime Architecture

| Concept | What it is | Lifetime |
|---------|-----------|----------|
| **Runtime** | The OrgLoop process. Event bus, scheduler, logger fanout, HTTP control server. One per host. | Host uptime |
| **Project** | A directory with `orgloop.yaml` + `package.json`. Defines sources, routes, transforms, actors. | Loaded at startup |

```
+-----------------------------------------------------------------+
|                          Runtime                                |
|                                                                 |
|  +----------+  +----------+  +------------+  +--------------+  |
|  | EventBus |  |Scheduler |  |Logger Mgr  |  | HTTP Server  |  |
|  |          |  |          |  |            |  |              |  |
|  |  shared  |  |  shared  |  |  shared    |  | control API  |  |
|  +----------+  +----------+  +------------+  +--------------+  |
|                                                                 |
|  +----------------------------------------------------------+  |
|  | Project: "engineering-org"                                |  |
|  |                                                           |  |
|  | sources: github, linear, claude-code                      |  |
|  | routes: github-pr-review, linear-to-eng, cc-supervisor    |  |
|  | actors: openclaw-engineering-agent                         |  |
|  | transforms: drop-bot-noise, dedup                         |  |
|  +----------------------------------------------------------+  |
+-----------------------------------------------------------------+
```

### Project Loading

When `orgloop start` runs:

1. Read `orgloop.yaml` and all referenced YAML files
2. Auto-discover routes from `routes/` directory
3. Resolve environment variables (`${VAR}` substitution)
4. Dynamically import connector/transform/logger packages from `node_modules/`
5. Create a `Runtime` instance and start shared infrastructure (bus, scheduler, HTTP server)
6. Load the resolved project config via `runtime.loadModule()` (internal API)
7. Sources begin polling, routes are registered, actors are ready

Internally, the project is loaded as a `ModuleInstance` -- this is an implementation detail. The user-facing concept is a project, not a module. The internal abstraction exists to keep the door open for future multi-project runtimes without breaking the current model.

### Runtime Modes

#### Foreground (development)

```bash
orgloop start
```

Runs in the foreground. Ctrl+C sends SIGINT for graceful shutdown. Ideal for development and debugging -- logs stream to the console.

#### Daemon (production)

```bash
orgloop start --daemon
```

Forks to background. PID written to `~/.orgloop/orgloop.pid`. Stdout/stderr redirected to `~/.orgloop/logs/daemon.stdout.log` and `daemon.stderr.log`. Use `orgloop stop` to shut down.

Before forking, the daemon checks for an already-running instance via the PID file. If one is found, it reports the error and exits.

#### Supervised Daemon (production, auto-restart)

```bash
orgloop start --daemon --supervised
```

Wraps the daemon in a `Supervisor` process that automatically restarts it on crash. Uses exponential backoff. Crash loop detection: if the process restarts more than 10 times within 5 minutes, the supervisor gives up.

The supervisor writes a heartbeat file (`~/.orgloop/heartbeat`) every 30 seconds with timestamp, PID, and uptime. This enables external monitoring tools to detect wedged processes.

### Signal Handling

| Signal | Behavior |
|--------|----------|
| `SIGINT` (Ctrl+C) | Graceful shutdown: flush loggers, save checkpoints, drain in-flight events, exit |
| `SIGTERM` | Same as SIGINT -- graceful shutdown |
| `uncaughtException` | Log error, attempt graceful shutdown, exit with code 1 |
| `unhandledRejection` | Log error, attempt graceful shutdown, exit with code 1 |

Graceful shutdown sequence:

1. Stop source polling (finish current poll cycle)
2. Drain in-flight events (deliver or timeout)
3. Flush log buffers
4. Save checkpoints to disk
5. Clean up PID and port files
6. Exit

### Shutdown via Control API

`orgloop stop` first attempts to shut down via the HTTP control API (`POST /control/shutdown`). If the control API is unreachable, it falls back to sending SIGTERM to the PID from the PID file. Either path triggers the graceful shutdown sequence.

### State Management

```
~/.orgloop/
├── orgloop.pid              # Runtime PID
├── runtime.port             # HTTP listener port
├── heartbeat                # Supervisor health heartbeat
├── state.json               # Runtime state snapshot (sources, routes, actors)
├── logs/
│   ├── orgloop.log          # Application logs
│   ├── daemon.stdout.log    # Daemon stdout
│   └── daemon.stderr.log    # Daemon stderr
└── data/
    ├── checkpoints/         # Per-source checkpoint files
    ├── wal/                 # Write-ahead log (event durability)
    └── queue/               # Queued events (degraded actors)
```

**Shared resources owned by the runtime:**
- Event bus -- events flow through the bus to the router
- Scheduler -- manages poll intervals for all sources
- Logger fanout -- distributes log entries to all configured loggers
- HTTP server -- control API + webhook listener (localhost, default port 4800)
- WAL -- write-ahead log for event durability

**Per-project resources:**
- Checkpoints -- each source tracks its own position independently
- Queue -- degraded actors store events locally until available
- State -- project metadata snapshot

### CLI Surface

```bash
# Runtime lifecycle
orgloop start                          # Start in foreground (development)
orgloop start --daemon                 # Start as background daemon
orgloop start --daemon --supervised    # Start as supervised daemon (auto-restart)
orgloop start --force                  # Skip doctor pre-flight checks
orgloop stop                           # Stop runtime gracefully
orgloop status                         # Runtime health + source/route/actor summary
```

**Pre-flight checks.** Before starting, `orgloop start` runs `orgloop doctor` checks. If critical errors are found, startup is blocked (use `--force` to bypass). If the environment is degraded (e.g., missing optional credentials), a warning is shown and startup proceeds.

### Event Flow

```
Source.poll() --> EventBus --> matchRoutes() --> Transform pipeline --> Actor.deliver()
                                                                           |
                                                                 actor.stopped --> EventBus (loops back)
```

Events carry their source origin. The router matches events against all routes in the project. Multi-route matching is supported -- one event can trigger multiple routes. Transform pipelines run sequentially per route.

### Networking: Future Design Space

The runtime architecture is designed with a networked future in mind, but explicitly defers building it.

**The BEAM analogy.** In Erlang/OTP, the VM hosts many applications. Each application is a supervision tree of processes. The VM can join a cluster -- processes become location-transparent, addressable by name regardless of which node hosts them. The runtime handles routing; the applications don't know or care.

**How this maps to OrgLoop:**

| BEAM concept | OrgLoop equivalent |
|---|---|
| VM (node) | Runtime |
| Application | Project workload |
| Process | Source / Route / Actor |
| Distributed Erlang | Networked runtime (future) |
| Process registry | Internal module registry |

**What we design for now:**
- Project names are globally meaningful (not just host-local)
- Events carry source origin metadata
- The internal registry interface doesn't assume locality (could back onto a distributed store)

**What we explicitly defer:**
- Multi-host runtime clustering
- Cross-host workload placement / scheduling
- Distributed event bus (Tier 2/3 from [Scale Design](./scale-design/))
- Workload migration (moving a running project between hosts)
- Consensus / split-brain handling

**Future multi-project runtime.** The internal `ModuleInstance` and `ModuleRegistry` abstractions support loading multiple projects into a single runtime. This capability is architecturally present but not exposed via the CLI. A future version could allow multiple people on a shared host to each load different OrgLoop projects into a single runtime -- one runtime, multiple projects, independent lifecycles, no restarts, no event gaps. This is explicitly deferred until there is a real need.

### Hot Reload (Future)

When a project's config changes, the runtime could reload it without stopping. The sequence:

1. Load new config alongside old
2. Diff: which sources/routes/actors changed?
3. Remove old routes, add new routes
4. For changed sources: flush checkpoint, reinit with new config
5. For unchanged sources: keep polling (no gap)

This is deferred. Currently, config changes require `orgloop stop` + `orgloop start`.

### Relationship to Existing Spec

| Spec section | How this relates |
|---|---|
| [Project Model](./modules/) | The project model defines the config structure. This spec defines how that config is loaded and managed at runtime. |
| [Runtime Modes](./runtime-modes/) | CLI/library/server modes are the *interface* to the runtime. This spec defines the runtime's *internal architecture*. |
| [Scale Design](./scale-design/) | Tier 1/2/3 scaling applies to the event bus and delivery fleet within the runtime. This spec is orthogonal -- it's about runtime lifecycle, not event throughput. |
| [Scope Boundaries](./scope-boundaries/) | OrgLoop still doesn't install software or broker credentials. The runtime is still just the routing layer -- now with explicit lifecycle management. |
