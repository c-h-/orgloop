---
title: "Scale Design"
description: "Spec management at scale, runtime architecture tiers, event persistence, delivery guarantees, and backpressure."
---

### 5.1 Spec Management at Scale

**Problem:** A Fortune 50 with 2,000 sources, 500 actors, and 10,000 routes can't manage a single directory of YAML files.

**Solution:** Projects per org, with workspaces for environment isolation.

#### Project-per-Org Pattern

Each organizational unit (team, department, org) gets its own OrgLoop project -- a directory with `orgloop.yaml` + `package.json`. Projects are self-contained: they declare their own connectors, routes, transforms, and loggers. See [Project Model](./modules/) for the current design.

At scale, a large organization runs multiple independent OrgLoop projects:

```
engineering/                    # Engineering org project
├── orgloop.yaml
├── package.json
├── connectors/
├── routes/
└── sops/

platform-ops/                   # Platform ops project
├── orgloop.yaml
├── package.json
├── connectors/
├── routes/
└── sops/

security/                       # Security team project
├── orgloop.yaml
├── package.json
├── connectors/
├── routes/
└── sops/
```

Each project runs its own `orgloop start` (or shares a runtime in a future multi-project mode). This provides natural isolation -- each team owns their config, dependencies, and event routing. Composition is handled by sharing connector packages across projects via npm.

#### Workspaces (Future)

Workspaces provide isolated state and configuration for different environments within a single project.

```bash
$ orgloop workspace list
  default
* staging
  production

$ orgloop workspace select production
Switched to workspace "production"
```

Each workspace has its own:
- Event store / checkpoint state
- Runtime configuration (poll intervals, endpoints)
- Variable overrides

```
engineering/
├── orgloop.yaml              # Base config
├── package.json
├── workspaces/
│   ├── staging.yaml          # Override: staging endpoints, faster polling
│   └── production.yaml       # Override: production endpoints, slower polling
├── connectors/
├── routes/
└── sops/
```

#### Plan/Apply Model

Borrowed directly from Terraform:

```
                    ┌──────────┐
  YAML files ──────►  validate ├──── syntax + schema errors
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │   plan   ├──── "3 sources added, 1 route changed,
                    └────┬─────┘      2 transforms removed"
                         │
                    ┌────▼─────┐
                    │  start   ├──── start/update runtime
                    └──────────┘
```

`orgloop plan` computes a diff between the current running state and the desired state from YAML files. `orgloop start` reconciles. This gives operators visibility and control over changes.

### 5.2 Runtime Scale

#### Architecture Tiers

```
┌─────────────────────────────────────────────────────────────┐
│                     TIER 1: Single Process                   │
│                  (MVP, small teams, dev/test)                 │
│                                                              │
│  ┌─────────┐  ┌──────────┐  ┌────────┐  ┌───────────────┐  │
│  │ Pollers │──► Event Bus │──► Router │──► Actor Delivery │  │
│  └─────────┘  │ (in-mem)  │  └────────┘  └───────────────┘  │
│               └──────────┘                                   │
│                    │                                         │
│               ┌────▼─────┐                                   │
│               │ File WAL │                                   │
│               └──────────┘                                   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                  TIER 2: Single Process + Queue               │
│              (Medium orgs, hundreds of sources)               │
│                                                              │
│  ┌─────────┐  ┌──────────────────┐  ┌────────┐  ┌────────┐ │
│  │ Pollers │──► NATS / Redis     │──► Router │──► Deliver │ │
│  └─────────┘  │ Streams          │  └────────┘  └────────┘ │
│               │ (persistent)     │                          │
│               └──────────────────┘                          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                  TIER 3: Distributed                          │
│           (Fortune 50, thousands of sources)                  │
│                                                              │
│  ┌──────────────┐    ┌───────────────────┐                  │
│  │ Poller Fleet  │───► Kafka / NATS      │                  │
│  │ (N instances) │    │ (partitioned by   │                  │
│  └──────────────┘    │  source)          │                  │
│                      └────────┬──────────┘                  │
│                    ┌──────────▼──────────┐                  │
│                    │  Router Fleet       │                  │
│                    │  (N instances,      │                  │
│                    │   partition-aware)  │                  │
│                    └──────────┬──────────┘                  │
│                    ┌──────────▼──────────┐                  │
│                    │  Delivery Fleet     │                  │
│                    │  (N instances)      │                  │
│                    └─────────────────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

**MVP ships Tier 1.** But we design the internal interfaces so swapping the event bus implementation is a one-line config change.

#### Event Bus Interface

```typescript
// The core abstraction that enables tiered scaling
export interface EventBus {
  /** Publish an event to the bus */
  publish(event: OrgLoopEvent): Promise<void>;

  /** Subscribe to events, optionally filtered */
  subscribe(filter: EventFilter, handler: EventHandler): Subscription;

  /** Acknowledge processing of an event (for at-least-once) */
  ack(eventId: string): Promise<void>;

  /** Get unacknowledged events (for recovery) */
  unacked(): Promise<OrgLoopEvent[]>;
}

// Implementations:
// - InMemoryBus     → Tier 1 (dev/small)
// - FileWalBus      → Tier 1 (production small)
// - NatsBus         → Tier 2
// - RedisBus        → Tier 2
// - KafkaBus        → Tier 3
```

#### Backpressure

When delivery to an actor fails or is slow:

1. **Per-route circuit breaker.** After N consecutive failures, the route enters a half-open state. Events queue (bounded). After a cooldown, a single event is retried. Success -> close circuit. Failure -> remain open.

2. **Bounded queues per actor.** Each actor target has a configurable queue depth (default: 1000). When full, oldest events are dropped with a `pipeline.backpressure` log entry. This prevents a slow actor from consuming all memory.

3. **Rate limiting.** Configurable per-route: max events/second to deliver to an actor. Excess events queue (bounded).

```yaml
# Route-level delivery configuration
routes:
  - name: high-volume-source
    when:
      source: telemetry
      events: [resource.changed]
    then:
      actor: processor
      delivery:
        max_rate: 100/s        # Rate limit
        queue_depth: 5000      # Max queued events
        retry:
          max_attempts: 3
          backoff: exponential
          initial_delay: 1s
          max_delay: 60s
        circuit_breaker:
          failure_threshold: 5
          cooldown: 30s
    with:
      prompt_file: "./sops/telemetry-alert.md"
```

### 5.3 Event Persistence & Delivery Guarantees

**Guarantee: At-least-once delivery.**

This is the right default for OrgLoop's use case. Actors may receive duplicate events — the `dedup` transform handles this for routes that need exactly-once semantics. At-least-once is achievable without the complexity of distributed transactions.

**Implementation (Tier 1 — File WAL):**

```
┌─────────────────────────────────────────────┐
│               Write-Ahead Log               │
│                                             │
│  1. Event received from source              │
│  2. Write to WAL (fsync)                    │
│  3. Process through pipeline                │
│  4. On successful delivery: mark WAL entry  │
│     as acknowledged                         │
│  5. On crash: replay unacked WAL entries    │
│                                             │
│  WAL file: ~/.orgloop/data/wal/             │
│  Format: append-only JSONL                  │
│  Rotation: configurable (size/time)         │
│  Compaction: remove acked entries on rotate  │
└─────────────────────────────────────────────┘
```

**State management:**

Each source connector maintains a **checkpoint** — an opaque string (typically a timestamp or cursor) that tells the connector where to resume polling after a restart. Checkpoints are persisted to `~/.orgloop/data/checkpoints/`.

```typescript
// Checkpoint store
export interface CheckpointStore {
  get(sourceId: string): Promise<string | null>;
  set(sourceId: string, checkpoint: string): Promise<void>;
}

// Implementations:
// - FileCheckpointStore      → JSON file per source
// - InMemoryCheckpointStore  → in-memory (for testing)
```
