---
title: "Runtime & Module Lifecycle"
description: "Runtime as a long-lived host process, modules as dynamically loadable workloads, identity model, state isolation, and the path to networked runtimes."
---

> **Status: Implemented.** The core architecture described here is implemented in `packages/core/src/runtime.ts`, `packages/core/src/module-instance.ts`, and `packages/core/src/registry.ts`. The `OrgLoop` engine class (`packages/core/src/engine.ts`) is a backward-compatible wrapper that creates a single "default" module within a Runtime. CLI support via `orgloop module` commands. Phase 1 (backwards compatible) and Phase 3 (dynamic module management) are live. Phase 2 (boot manifest with `modules:` section) is config-only — not yet implemented.

### Core Insight: Separate the Runtime from the Workload

Today, OrgLoop conflates two concerns:

1. **Runtime infrastructure** — the event bus, scheduler, logger fanout, checkpoint store, HTTP listener
2. **Workloads** — the sources, routes, transforms, and actors that do actual work

These have different lifecycles. The runtime is long-lived infrastructure. Workloads (modules) are added, removed, updated, and restarted independently. Tying them together via a single config file means every module change requires a full runtime restart — disrupting all running modules, creating event gaps, and forcing every source to replay from its last checkpoint.

**The design:** the runtime is an independent, long-lived process. Modules are dynamically loaded and unloaded within it.

### Three Abstractions

| Concept | What it is | Lifetime |
|---------|-----------|----------|
| **Runtime** | The OrgLoop process. Event bus, scheduler, logger fanout, module registry. One per host (for now). | Host uptime |
| **Module** | A named collection of sources, routes, transforms, actors. The logical unit of management. | Independent — loaded/unloaded without affecting other modules |
| **Registry** | Maps module names to loaded instances. Enforces singleton semantics per name. | Runtime lifetime |

The runtime is infrastructure. Modules are workloads. The registry is the control plane.

```
┌─────────────────────────────────────────────────────────────────┐
│                          Runtime                                 │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌──────────────┐  │
│  │ EventBus │  │Scheduler │  │Logger Mgr  │  │  Registry    │  │
│  │          │  │          │  │            │  │              │  │
│  │  shared  │  │  shared  │  │  shared    │  │ name → mod   │  │
│  └──────────┘  └──────────┘  └────────────┘  └──────────────┘  │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │ Module:          │  │ Module:          │  │ Module:      │  │
│  │ "engineering"    │  │ "ops-alerts"     │  │ "personal"   │  │
│  │                  │  │                  │  │              │  │
│  │ sources: 2      │  │ sources: 1      │  │ sources: 1   │  │
│  │ routes: 4       │  │ routes: 2       │  │ routes: 1    │  │
│  │ actors: 1       │  │ actors: 1       │  │ actors: 1    │  │
│  └──────────────────┘  └──────────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Module Identity

**Named modules are singletons.** A module's `name` (from its manifest `metadata.name`) is its identity within the runtime. The registry enforces: one instance per name. Attempting to load a second module with the same name is rejected (or triggers a reload — see [Hot Reload](#hot-reload-future)).

This solves the **git worktree problem.** If the same project exists at `/work/orgloop` and `/work/orgloop-2` (worktrees), and both declare `name: engineering`, only one can be loaded. The name is the singleton lock, not the filesystem path.

**Unnamed modules** derive identity from a hash of their resolved config file path. They work, but lack singleton protection across paths. Named modules are the encouraged default.

```yaml
# orgloop-module.yaml — the name is the identity
apiVersion: orgloop/v1alpha1
kind: Module
metadata:
  name: engineering       # Singleton within the runtime
  description: "Engineering org workflows"
```

### Module Lifecycle

Modules have four lifecycle states:

```
loading → active → unloading → removed
                ↑               │
                └───── reload ──┘
```

| State | Meaning |
|-------|---------|
| `loading` | Sources initializing, routes registering, transforms wiring |
| `active` | Sources polling, routes matching, events flowing |
| `unloading` | Sources stopping, in-flight events draining, checkpoints flushing |
| `removed` | Fully unloaded, state preserved on disk for next load |

**Loading a module:**
1. Validate manifest and config
2. Resolve connectors (sources, actors)
3. Register routes in the router (namespaced with module name)
4. Initialize sources (start polling via shared scheduler)
5. Mark module `active` in registry

**Unloading a module:**
1. Stop source polling (graceful — finish current poll cycle)
2. Drain in-flight events (deliver or timeout)
3. Flush checkpoints to disk
4. Remove routes from router
5. Mark module `removed` in registry

Other modules are unaffected. The event bus keeps running. Sources from other modules keep polling.

### State Isolation

Each module owns its state. Shared infrastructure routes to the right namespace.

```
~/.orgloop/
├── runtime.pid              # Runtime PID (one per host)
├── runtime.port             # HTTP listener port
├── modules/
│   ├── engineering/
│   │   ├── checkpoints/     # Per-source checkpoint files
│   │   ├── state.json       # Module-specific state
│   │   └── queue/           # Queued events (degraded actors)
│   ├── ops-alerts/
│   │   ├── checkpoints/
│   │   ├── state.json
│   │   └── queue/
│   └── personal/
│       ├── checkpoints/
│       ├── state.json
│       └── queue/
├── logs/                    # Shared log directory (module name in entries)
└── data/
    └── wal/                 # Shared WAL (events tagged with module)
```

**Shared resources:**
- Event bus — one bus, events tagged with `module` origin
- Scheduler — one scheduler, polls tagged with module
- Logger fanout — one pipeline, module name in every log entry
- WAL — one log, module name in every entry

**Per-module resources:**
- Checkpoints — each module's sources track their own position independently
- Queue — degraded actors store events per-module
- State — module-specific metadata

### CLI Surface

```bash
# Runtime lifecycle
orgloop start                          # Start runtime, load modules from boot config
orgloop stop                           # Stop runtime (gracefully unloads all modules)
orgloop status                         # Runtime health + all loaded modules summary

# Module lifecycle
orgloop module load <name-or-path>     # Load a module into the running runtime
orgloop module unload <name>           # Unload a module (preserves state on disk)
orgloop module reload <name>           # Unload + load (picks up config changes)
orgloop module list                    # List loaded modules with status
orgloop module status <name>           # Detailed status for one module
```

**Boot config.** `orgloop start` reads `orgloop.yaml` in CWD (or `--config`) as a **boot manifest** — the initial set of modules to load. This is a convenience, not a constraint. Once the runtime is running, the registry is the source of truth. Modules can be loaded and unloaded dynamically without touching the boot config.

```yaml
# orgloop.yaml — boot manifest
modules:
  - package: "@orgloop/module-engineering"
    params:
      github_source: github
      agent_actor: engineering

  - package: "@orgloop/module-ops-alerts"
    params:
      pagerduty_source: pagerduty
      agent_actor: ops
```

Running `orgloop start` with this config starts the runtime and loads both modules. Later, `orgloop module load ./personal` adds a third module without restarting.

### Shared-Host Scenario

Multiple people on a shared host, each developing different OrgLoop modules:

```bash
# Alice, developing an engineering workflow
alice$ orgloop module load ./engineering
# Loaded "engineering" into runtime (PID 42)

# Bob, developing an ops workflow
bob$ orgloop module load ./ops-alerts
# Loaded "ops-alerts" into runtime (PID 42)

# Alice updates her module
alice$ orgloop module reload engineering
# Unloaded "engineering", reloaded with updated config
# Bob's "ops-alerts" never interrupted

# Charlie checks what's running
charlie$ orgloop module list
# NAME           STATUS   SOURCES  ROUTES  UPTIME
# engineering    active   2        4       2h 15m
# ops-alerts     active   1        2       45m
```

One runtime, multiple modules, independent lifecycles. No restarts. No event gaps.

### Event Flow with Modules

Events carry their module origin. The router matches within and (eventually) across modules.

```
Source.poll() ──[tagged: module=engineering]──► EventBus
                                                   │
                        ┌──────────────────────────┤
                        ▼                          ▼
              Route: engineering-*          Route: ops-*
              (matches module's routes)    (does NOT match — different module)
                        │
                        ▼
              Transform pipeline ──► Actor.deliver()
```

**Current scope:** routes match only within their own module. A module's sources only trigger that module's routes.

**Future scope (cross-module routing):** explicit opt-in. A route could declare `when: { source: "engineering:github" }` to listen to another module's source. This enables composition patterns like a supervision module that observes all `actor.stopped` events across modules. But this is explicitly deferred — it requires careful thought about module isolation boundaries.

### Migration Path

**From current (single config, single process) to multi-module runtime:**

1. **Phase 1 (backwards compatible):** `orgloop start` with a flat config (no `modules:` section) loads everything as a single implicit module named `"default"`. Existing setups work unchanged.

2. **Phase 2:** Users can add `modules:` to their config, splitting their flat config into named modules. The runtime loads them independently.

3. **Phase 3:** Dynamic module management via CLI. `orgloop module load/unload/reload` for live module lifecycle.

Each phase is additive. No breaking changes. A user who never touches modules gets the same behavior as today.

### Networking: Future Design Space

The runtime/module separation is designed with a networked future in mind, but explicitly defers building it.

**The BEAM analogy.** In Erlang/OTP, the VM hosts many applications (modules). Each application is a supervision tree of processes. The VM can join a cluster — processes become location-transparent, addressable by name regardless of which node hosts them. The runtime handles routing, the applications don't know or care.

**How this maps to OrgLoop:**

| BEAM concept | OrgLoop equivalent |
|---|---|
| VM (node) | Runtime |
| Application | Module |
| Process | Source / Route / Actor |
| Distributed Erlang | Networked runtime (future) |
| Process registry | Module registry |
| `{:global, :name}` | Module name (singleton) |

**What we design for now:**
- Module names are globally meaningful (not just host-local)
- Events carry module origin metadata
- The registry interface doesn't assume locality (could back onto a distributed store)
- State isolation is per-module, not per-host

**What we explicitly defer:**
- Multi-host runtime clustering
- Cross-host module placement / scheduling
- Distributed event bus (Tier 2/3 from [Scale Design](./scale-design/))
- Module migration (moving a running module between hosts)
- Consensus / split-brain handling

The key constraint: **don't make decisions now that close the door on networking later.** Module names as identity (not PIDs or paths), events with module metadata, and a registry abstraction that could back onto etcd/NATS — these keep the door open.

### Relationship to Existing Spec

| Spec section | How this relates |
|---|---|
| [Modules](./modules/) | Modules define the workload contract (manifest, parameters, composition). This spec defines how those modules are managed at runtime. |
| [Runtime Modes](./runtime-modes/) | CLI/library/server modes are the *interface* to the runtime. This spec defines the runtime's *internal architecture*. |
| [Scale Design](./scale-design/) | Tier 1/2/3 scaling applies to the event bus and delivery fleet within the runtime. This spec is orthogonal — it's about module lifecycle, not event throughput. |
| [Scope Boundaries](./scope-boundaries/) | OrgLoop still doesn't install software or broker credentials. The runtime is still just the routing layer — now with explicit module lifecycle management. |

### Hot Reload (Future)

When a module's config changes, the runtime should be able to reload it without affecting other modules. The sequence:

1. Load new config alongside old
2. Diff: which sources/routes/actors changed?
3. Remove old routes, add new routes
4. For changed sources: flush checkpoint, reinit with new config
5. For unchanged sources: keep polling (no gap)

This is `orgloop module reload <name>`. It's a clean unload-then-load with the optimization of preserving unchanged sources. Deferred to Phase 3.
