---
title: "MVP Validation Plan"
description: "Migration map, MVP scope, testing strategy, and success criteria for OrgLoop's initial release."
---

### 6.1 Migration Map

| Current Script | OrgLoop Equivalent | Connector | Type |
|---|---|---|---|
| `~/.openclaw/scripts/github-activity-feed/poll.sh` | `@orgloop/connector-github` source | GitHub | Poll-based |
| `~/.openclaw/scripts/linear-activity-feed/poll.sh` | `@orgloop/connector-linear` source | Linear | Poll-based |
| `~/.openclaw/scripts/claude-code/notify-openclaw.sh` | `@orgloop/connector-claude-code` source | Claude Code | Hook-based |
| OpenClaw webhook (`POST /hooks/agent`) | `@orgloop/connector-openclaw` target | OpenClaw | Webhook |
| LaunchAgent plists (cron) | OrgLoop scheduler (built-in) | -- | Runtime |
| Ad-hoc jq filtering | `@orgloop/transform-filter` + scripts | -- | Transform |

### 6.2 MVP Scope

**In scope:**
- Core runtime: event bus (in-memory + file WAL), router, transform pipeline, logger fan-out
- CLI: `init`, `validate`, `plan`, `start`, `stop`, `status`, `logs`, `test`, `env`, `doctor`, `routes`, `hook`, `add`, `inspect`, `install-service`, `service`, `version`
- Connectors: `github`, `linear`, `claude-code`, `openclaw`, `webhook`
- Transforms: `filter` (jq-based), `dedup`, shell script executor
- Loggers: `file` (JSONL), `console`
- Scheduler: poll-based scheduling with configurable intervals
- Checkpoint persistence: file-based
- Config: YAML schema + JSON Schema validation
- Launch prompts: `with.prompt_file` route property for situational SOPs
- Package-native project model: `package.json` + `orgloop.yaml`, connectors resolve from `node_modules/`
- Webhook server: lightweight HTTP listener for hook-based sources (port 4800)

**Out of scope for MVP:**
- Workspaces (Tier 2+ concern)
- Distributed runtime / queue backends (NATS, Kafka)
- HTTP API server / `orgloop serve` (CLI-only for MVP)
- OpenTelemetry logger
- Plugin registry / discovery
- Hot-reload of config changes
- Windows support
- Web dashboard

### 6.3 Migration Strategy

**Philosophy:** The existing scripts are bespoke shell scripts that are probably less reliable than OrgLoop will be. There's no value in a sophisticated shadow/parallel migration — just build the equivalent, test it, and cut over. One connector at a time.

#### Approach: Build -> Test -> Cut Over

For each connector (starting with GitHub, then Linear, then Claude Code):

**Step 1: Build the connector.**
Implement the `SourceConnector` interface for the equivalent functionality. Map the existing script's API calls, filters, and output format to OrgLoop's event model.

**Step 2: Test standalone.**
Inject test events and verify delivery. Use `orgloop test` to trace events through the full pipeline:

```bash
# Generate a sample event matching the connector's output
orgloop test --generate github > test-event.json

# Inject and trace
orgloop test test-event.json
# → Shows: source.emit → transform.pass → route.match → deliver.success

# Run the connector in poll mode against the real API (read-only, safe)
orgloop start --dry-run --source github
# → Shows events that would be routed, without delivering
```

**Step 3: Hard cut over.**
- Disable the old LaunchAgent plist / cron job
- Enable the OrgLoop connector via `orgloop start`
- Monitor `orgloop status` and `orgloop logs` for the first hour

**Step 4: Clean up.**
After 1 week of stable operation, remove the old script files and LaunchAgent plists.

#### Migration Order

1. **GitHub connector** — highest event volume, most complex normalization. Proves the core pipeline works.
2. **Linear connector** — similar pattern to GitHub (poll-based, API normalization). Validates the pattern is repeatable.
3. **Claude Code connector** — different pattern (hook-based, not poll-based). Validates the hook/event model.

#### Why NOT Shadow/Parallel

- The existing scripts are simple enough that equivalence testing is straightforward — inject the same API response, verify the same output.
- Running two systems in parallel doubles the complexity and doubles the chance of double-delivering events to OpenClaw.
- If OrgLoop has a bug, it's faster to fix forward than to run parallel for weeks and diff outputs.
- We're the only users. Roll back is "re-enable the LaunchAgent plist."

### 6.4 Success Criteria

| Criterion | Measurement |
|-----------|-------------|
| **Parity** | Every event type the old scripts handle is also handled by OrgLoop connectors |
| **Latency** | Events are delivered to OpenClaw within 30s of poll interval (comparable to current) |
| **Reliability** | Zero dropped events over a 7-day run (verified by WAL + delivery logs) |
| **Recovery** | After a process crash, OrgLoop resumes from checkpoint and replays undelivered events |
| **Developer experience** | A new contributor can `orgloop init`, add a connector, and run `orgloop start` in under 15 minutes |

### 6.5 Testing Strategy

**A deterministic system must be provably deterministic.** Testing isn't a nice-to-have — it's how we prove OrgLoop does exactly what it claims. The core invariant: **every event that enters the system MUST either be delivered to exactly one actor or explicitly dropped by a transform. No silent failures. Ever.**

#### Property-Based Testing

Use a property testing framework (e.g., [fast-check](https://github.com/dubzzz/fast-check)) to verify core invariants across random event streams.

**Core invariant:** For any random event E injected into the pipeline:
- E is delivered to exactly the actors matched by its routes, OR
- E is explicitly dropped by a transform (logged with `transform.drop` and the transform name), OR
- E matches no routes (logged with `route.no_match`)

There is no fourth option. No event enters the system and disappears without a trace.

**Properties to test:**
- **Completeness:** Every published event has a terminal log entry (`deliver.success`, `deliver.failure`, `transform.drop`, or `route.no_match`).
- **Determinism:** The same event, config, and transforms produce the same routing outcome every time. Run 1000 random events, replay them, verify identical results.
- **Idempotency:** Processing the same event twice (at-least-once delivery) produces at most one additional delivery per route (the dedup transform can be tested for exactly-once).
- **Ordering:** Events from a single source are processed in order. Events from different sources have no ordering guarantee (and the system doesn't silently impose one).

#### Delivery Guarantees Testing

**At-least-once under crash scenarios.** This is the hardest property to test and the most important.

Test procedure:
1. Start the runtime with file WAL enabled
2. Inject N events
3. After K events are published to WAL but before all are delivered: `kill -9` the process
4. Restart the runtime
5. Verify: every event in the WAL is either already delivered (acked) or is redelivered on restart
6. Verify: no WAL entry is permanently lost

Automate this with a test harness that randomly kills the process at different pipeline stages (post-WAL-write, post-transform, mid-delivery) and verifies recovery.

#### Transform Contract Testing

Transforms have a strict contract. Test every edge case exhaustively:

| Input | Exit Code | Stdout | Expected Behavior |
|-------|-----------|--------|-------------------|
| Valid event JSON | 0 | Modified JSON | Event continues with modifications |
| Valid event JSON | 0 | Empty | Event is **dropped** (logged as `transform.drop`) |
| Valid event JSON | 1 | Any | Event is **dropped** (logged as `transform.drop`) |
| Valid event JSON | 2 | Any | Transform **error** — event continues, error logged |
| Valid event JSON | 137 (killed) | Any | Transform **error** — timeout, event continues |
| Malformed JSON | 0 | Anything | Source error — should not reach transforms |

Verify these semantics for:
- Every built-in transform
- The shell script executor (which wraps arbitrary scripts)
- The package transform executor

#### End-to-End Event Tracing

Every event gets a `trace_id`. The log MUST show a complete lifecycle for every event:

```
trace_id: trc_abc123
├── source.emit        github         resource.changed    evt_001   t=0ms
├── transform.start    drop-bot-noise                     evt_001   t=1ms
├── transform.pass     drop-bot-noise                     evt_001   t=3ms
├── transform.start    injection-scan                     evt_001   t=3ms
├── transform.pass     injection-scan                     evt_001   t=18ms
├── route.match        github-to-eng                      evt_001   t=18ms
├── deliver.attempt    openclaw-engineering-agent                   evt_001   t=19ms
└── deliver.success    openclaw-engineering-agent                   evt_001   t=108ms
```

For dropped events:
```
trace_id: trc_def456
├── source.emit        github         resource.changed    evt_002   t=0ms
├── transform.start    drop-bot-noise                     evt_002   t=1ms
└── transform.drop     drop-bot-noise  reason="bot"       evt_002   t=2ms
```

Test: inject 100 events with various routing outcomes, then query the log and verify that every `trace_id` has a complete, well-formed lifecycle with a terminal entry.

#### Regression Suite

As connectors are added, each gets an integration test that verifies events flow end-to-end:

```typescript
// connectors/github/__tests__/integration.test.ts
test('GitHub PR review event flows through pipeline to mock actor', async () => {
  const mockActor = createMockActor();
  const engine = createTestEngine({
    sources: [githubSource({ mockResponses: [prReviewPayload] })],
    actors: [mockActor],
    routes: [{ source: 'github', actor: 'mock', events: ['resource.changed'] }],
  });

  await engine.poll('github');

  expect(mockActor.delivered).toHaveLength(1);
  expect(mockActor.delivered[0].type).toBe('resource.changed');
  expect(mockActor.delivered[0].provenance.platform).toBe('github');
});
```

Every connector has at least:
- One test per event type it emits
- One test verifying normalization (raw API response -> OrgLoop event format)
- One test verifying checkpoint behavior (poll with checkpoint, poll without)

#### CI Requirements

- **Every PR must pass the full test suite.** No exceptions. No "we'll fix it later."
- CI runs:
  1. Unit tests (fast — all property tests, transform contract tests, core logic)
  2. Integration tests (medium — each connector with mocked APIs)
  3. End-to-end tests (slower — full pipeline with WAL, crash recovery)
- CI does NOT run smoke tests against real APIs (those are manual pre-release).
- Test coverage is tracked but not gated by percentage — property tests and e2e tests matter more than line coverage.

**The goal:** After CI passes, we have VERY high confidence that the core routing engine does exactly what it claims, under normal operation and under crash/failure scenarios.
