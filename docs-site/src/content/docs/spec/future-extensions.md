---
title: "Future Extensions (Appendix D)"
description: "Design gaps and planned capabilities — async delivery, actor adapters, event aggregation, observability, and more."
---

Design gaps and planned capabilities discovered during development. Each item describes the gap, the current workaround (if any), and the intended solution.

When an item is implemented, move it to the relevant spec file and mark it resolved here.

Items are referenced from `local/WORK_QUEUE.md` by FE-XX ID.

---

### FE-01: Async Actor Delivery (`status: 'accepted'` + `tracking_id`)

**Gap:** `DeliveryResult.status` only supports `'delivered' | 'rejected' | 'error'`. Actors like deep-research (30+ min), ChatGPT Pro (3-70 min), and supervisor agent (unbounded) accept work but don't complete immediately. There's no way to express "work queued, will complete later."

**Current workaround:** Treat webhook acceptance (HTTP 200) as `'delivered'`, even though the actor hasn't finished. No correlation back to the original event when work completes.

**Intended solution:**
- Add `status: 'accepted'` to `DeliveryResult`
- Add `tracking_id: string` to `DeliveryResult` for correlating completion events
- Actor completion feeds back as `actor.stopped` with `tracking_id` in provenance
- Engine can correlate delivery -> completion via tracking_id

**Affects:** `packages/sdk/src/connector.ts`, `packages/core/src/runtime.ts` (core runtime logic; `engine.ts` is now a backward-compatible wrapper), [Event Schema](./event-schema/)

---

### ~~FE-02: `orgloop hook` CLI Command + Engine HTTP Listener~~ **Resolved (MVP)**

Implemented:
- `orgloop hook claude-code-stop` CLI command reads stdin, POSTs to `http://127.0.0.1:<port>/webhook/<sourceId>`
- Engine starts `WebhookServer` (lightweight HTTP listener, localhost-only, default port 4800) when any webhook-based source is configured
- `packages/core/src/http.ts` — `WebhookServer` class routes `POST /webhook/:sourceId` to registered handlers
- `packages/cli/src/commands/hook.ts` — stdin-to-HTTP bridge
- `orgloop init` installs `orgloop hook claude-code-stop` pointing to the engine's listener

---

### FE-03: Actor Delivery Adapters (CLI, File, Browser, Message)

**Gap:** Current actor delivery assumes HTTP webhook. Five distinct delivery patterns exist in the ecosystem:

| Pattern | Examples |
|---------|----------|
| HTTP webhook | OpenClaw, generic webhooks (working) |
| CLI invocation | deep-research, narrator, reviewer, scanner |
| File I/O | deep-research output, narrator audio |
| Browser automation | ChatGPT Pro |
| Message passing | supervisor/reviewers |

**Current workaround:** Only HTTP webhook delivery is implemented. Other actors must be wrapped in HTTP endpoints or triggered manually.

**Intended solution:**
- Create `DeliveryAdapter` abstraction layered on top of `ActorConnector`
- Implement adapters: `WebhookDeliveryAdapter` (exists), `CLIDeliveryAdapter`, `FileDeliveryAdapter`, `BrowserDeliveryAdapter`, `MessagePassingAdapter`
- Allow `RouteDeliveryConfig` to hint at delivery requirements (`actor_type`, `expected_duration`, `response_mode`)

**Affects:** `packages/sdk/src/connector.ts`, new adapter packages

---

### FE-04: CWD-Based Routing for Claude Code Events

**Gap:** The bespoke `notify-openclaw.sh` routes Claude Code sessions to different agents based on working directory (`~/code/mono*` -> work team via Slack, `~/personal/*` -> personal via Mattermost). The OrgLoop production config routes all `actor.stopped` events to a single agent.

**Current workaround:** Single route to `openclaw-engineering-agent`. CWD info is in the event payload so the agent can see it, but routing is not differentiated.

**Intended solution:**
- Multiple routes with transform-filter using regex on `payload.working_directory`
- Multiple actor configs (work-agent, personal-agent) with different channels/targets
- Transform-filter already supports `/regex/` patterns — config-only change

**Affects:** Route config, actor config (no code changes needed)

---

### FE-05: Linear User-Level Filtering

**Gap:** The bespoke Linear script filters issues by a specific user ID. The OrgLoop Linear connector filters by team, returning all team activity. This is noisier.

**Current workaround:** Accept all team activity. Could add a transform-filter on `provenance.author` with regex.

**Intended solution (options):**
- **Config-only:** Add transform-filter with `match: { provenance.author: "/alice|a-smith/i" }` to Linear routes
- **Connector-level:** Add optional `assignee` filter to `LinearSourceConfig` to filter at the GraphQL query level (reduces API calls)

**Affects:** `connectors/linear/src/source.ts` (if connector-level), route/transform config (if config-only)

---

### ~~FE-06: CLI Env Var Onboarding UX~~ **Resolved (MVP)**

Implemented:
- `ConnectorSetup.env_vars` supports `EnvVarDefinition` with per-variable `description` and `help_url`
- `orgloop env` shows set/unset status with `description` and `help_url` per variable
- `orgloop init` shows indicators with connector-provided guidance for missing vars
- `orgloop start` runs a pre-flight env var check before config loading
- `orgloop doctor` reports credential status with descriptions and help URLs
- `env-metadata.ts` provides hardcoded metadata as a fallback for known env vars
- Remaining: `.env` file loading in `orgloop start` (dotenv or similar)

---

### FE-07: OpenClaw as a Source Connector

**Gap:** OpenClaw is currently target-only. It receives events but doesn't emit them. If an OpenClaw agent completes work, there's no way for that completion to feed back into OrgLoop as an `actor.stopped` event.

**Current workaround:** None. The feedback loop is broken for OpenClaw-delivered work.

**Intended solution:**
- Build `connector-openclaw` source that polls or subscribes to OpenClaw session completions
- Or: OpenClaw POSTs completion events to OrgLoop's webhook endpoint (requires FE-02)

**Affects:** `connectors/openclaw/`, possibly new source connector

---

### FE-08: Event Aggregation & Windowing

**Gap:** Routes trigger actors on individual events. No way to batch N events before triggering, collapse similar events into one (beyond dedup's exact-match), or trigger on event absence ("no PR reviews in 2 hours").

**Intended solution:**
- Window transform: accumulate events matching a pattern, emit a single aggregated event after N events or T time
- Absence trigger: emit a synthetic event when a source produces no events within a configurable window
- Collapse: merge N similar events into one summary event

**Affects:** New transform package(s), possibly scheduler integration for time-based windows

---

### FE-09: Multi-Org Composition

**Gap:** Running multiple orgs or composing one org from pieces of another.

**Intended solution:** Explore later. Possible directions: multiple config roots per instance, cross-org event routing, credential isolation between orgs, module composition with overrides.

**Affects:** Core architecture, config schema, module system

---

### FE-10: Observability Beyond Logs

**Gap:** MVP has file + console loggers. No metrics, alerting, or dashboards.

**Intended solution:**
- Structured metrics: event rate, delivery success/failure/latency, transform drop rate, source poll duration
- OpenTelemetry logger (traces + metrics export)
- Alert conditions: delivery failure rate > threshold, source stalled, transform error spike

**Affects:** `packages/core/src/runtime.ts` (core runtime logic; `engine.ts` is now a backward-compatible wrapper), new logger packages

---

### FE-11: Event Replay & Time-Travel Debugging

**Gap:** Can't replay a past event through the pipeline.

**Intended solution:**
- `orgloop replay <event-id>` — re-inject a logged event
- `--from/--to` for time range replay
- `--dry-run` mode shows what would happen without delivering

**Affects:** `packages/cli/`, `packages/core/src/runtime.ts` (`engine.ts` is now a backward-compatible wrapper)

---

### FE-12: Secret Management Integrations

**Gap:** Secrets are env vars only. No vault integration, rotation, or audit trail.

**Intended solution:**
- Pluggable secret resolver interface: `resolve(ref: string) -> string`
- Built-in: env var, `.env` file. Community: Vault, AWS SM, 1Password CLI
- Config syntax: `token: "vault:secret/data/github#token"` or similar URI scheme

**Affects:** `packages/core/src/schema.ts`, new secret resolver interface in SDK

---

### ~~FE-13: Cron Source Connector~~ **Resolved (MVP)**

Implemented as `@orgloop/connector-cron`. Supports standard 5-field cron expressions and interval-based schedules (`every 5m`, `every 1h`). Emits `resource.changed` with `provenance.platform: 'cron'` and `provenance.platform_event: 'schedule.<name>'`. Poll-based: on each poll, checks whether any scheduled cron time has passed since the last checkpoint. See `connectors/cron/src/source.ts`.

---

### FE-14: Communications Platform Connectors (Human-in-the-Loop)

**Gap:** No way to route events to humans via comms platforms.

**Intended solution:** Slack (API), Discord, email, Mattermost as both source and target connectors. Enables human approval gates via `message.received` feedback.

---

### ~~FE-15: Installable Organization Modules~~ **Resolved (MVP)**

Implemented. See [spec 12 (Modules)](./modules/) for the design. Module manifest validation via AJV, `{{ params.X }}` / `{{ module.name }}` / `{{ module.path }}` template expansion, module resolution (local paths and npm packages), namespaced route composition, and `modules/engineering/` as the first built-in module.

---

### FE-16: Property-Based Testing

**Gap:** All tests are example-based. No property tests exercising invariants.

**Intended solution:** Add `fast-check` for core invariants: router matching laws, transform pipeline composition, event schema round-trips, config env var substitution.

---

### FE-17: Environment Orchestrator (Sister Project)

**Gap:** OrgLoop declares what an organization needs but doesn't install services, broker credentials, or configure hooks across systems. The "blank machine -> running org" story requires tooling outside OrgLoop's scope.

**Intended solution:** `orgctl` — a sister project that reads the same module manifest and handles Tier 4 (local service installation) and Tier 5 (cross-system configuration). See the [orgctl RFP](https://orgloop.ai/vision/orgctl/) for the full project specification and [spec 14 (Scope Boundaries)](./scope-boundaries/) for the shared contract model.

**Depends on:** OrgLoop Phase 4 (stable module manifest schema), `orgloop doctor --json`, `--non-interactive` CLI flags.

---

### ~~FE-18: Route Visualization~~ **Resolved (MVP)**

Implemented as `orgloop routes` command. ASCII rendering shows sources -> routes (with filter criteria and transform chains) -> actors. Highlights unrouted sources and unreachable actors as warnings. Supports `--json` for machine-readable graph data (nodes, edges, warnings). See `packages/cli/src/commands/routes.ts`.

---

### FE-19: Source Scoping vs. Event Filtering

**Gap:** Connectors like GitHub and Linear fetch all events for a team/repo, then rely on transforms to filter. The bespoke scripts they replace filtered at the API level (only PRs by specific authors, only issues assigned to a user). This causes unnecessary API calls and noisy logs.

**Design decision: Keep filtering at the route/transform level, NOT in connectors.**

**Rationale:**
1. **Observability** — if a connector silently drops events, `orgloop logs` can't show what's happening. Users can't answer "is data flowing?" vs. "is there a filter I forgot about?"
2. **Composability** — one team filters by assignee, another by project. Connector config becomes a bag of N filter options. Transforms are the composable mechanism.
3. **Debugging** — event flow is always traceable: source emitted -> bus received -> route matched -> transform filtered -> actor received. No hidden drops.
4. **Separation of concerns** — sources observe, transforms decide, routes deliver.

**Connector `scope` (future, optional):**
- API-level scoping (e.g., `scope: { assignee: "me" }`) is a valid **performance optimization** — fewer API calls, less network traffic.
- Should be framed as `config.scope` NOT as event filtering. Clearly documented as "reduces API usage, not event semantics."
- Events within scope still flow through the full pipeline (bus -> transforms -> delivery).
- Events outside scope are never fetched — this is a data fetch boundary, not a filter.

**What's needed now (short-term):**
- Connectors should emit richer `provenance` fields (assignee, author list, PR authors) so route-level filters can match on them using existing regex/match transform capabilities.
- Linear: add `provenance.assignee` to issue events
- GitHub: add `provenance.pr_author` to PR events

**Affects:** `connectors/*/src/`, `packages/sdk/src/connector.ts` (provenance type), transform-filter docs

---

### FE-20: Actor-to-OrgLoop Event Emission (Mid-Session)

**Gap:** Actors can only emit events via `actor.stopped` -- after their session ends. An actor mid-session has no way to say "route this event now" without completing. This limits actor-to-actor coordination to sequential handoffs (actor A finishes, actor B starts). Richer patterns -- like an actor requesting help from another actor while continuing its own work -- are not possible.

**Current workaround:** None. Actors must complete before their output becomes routable. Multi-step workflows require supervisor-mediated re-dispatch.

**Intended solution:**
- Provide a standardized interface (MCP tool, HTTP endpoint, or SDK method) that actors can call mid-session to emit events into OrgLoop's bus
- New event type or use of `message.received` with actor provenance
- Engine routes the emitted event through normal pipeline (bus -> routes -> transforms -> delivery)
- Actor continues running -- emission is fire-and-forget from the actor's perspective

**Design considerations:**
- Must not create tight coupling between actor runtime and OrgLoop engine
- Should work regardless of actor type (Claude Code, Codex, custom agents)
- MCP tool approach: OrgLoop provides an MCP server with an `emit_event` tool that agents can call
- HTTP approach: actors POST to `http://localhost:<port>/emit` (similar to webhook source, but for outbound from actors)
- Rate limiting and loop detection needed to prevent infinite emission chains

**Affects:** `packages/core/src/runtime.ts` (core runtime logic; `engine.ts` is now a backward-compatible wrapper), `packages/core/src/http.ts`, `packages/sdk/src/connector.ts`, possibly new MCP server package

---

### ~~FE-21: Transform Failure Policy (Fail-Open vs Fail-Closed)~~ **Resolved**

Implemented per-transform `on_error` policy with three modes:
- `pass` (fail-open, default) — event passes through unmodified on error (backwards-compatible)
- `drop` (fail-closed) — event is silently dropped on error
- `halt` — pipeline halts with error, engine emits error event

Configurable at both the transform definition level (global default) and the route transform reference level (per-route override). Route-level takes precedence. Dedicated log phases: `transform.error_drop` and `transform.error_halt`. See [Built-in Transforms spec, section 10.4](./transforms/) for full documentation.

---

### FE-22: Module Trust & Permissions

**Gap:** Modules are "installable organizations" — they bundle routes, SOPs, transforms, and dependency declarations. The moment third-party modules exist, trust becomes critical: a module's SOPs can instruct actors to do arbitrary things (merge PRs, close tickets, provision resources). Users need to understand what a module will do before installing it.

**Solution direction:**
- Module manifest declares **permissions** (what event types it routes, what actor capabilities it assumes, what env vars it requires)
- `orgloop add module <name>` shows a permission summary before installing (similar to mobile app permission prompts)
- Optional module signing (npm provenance, cosign, or similar) for verified publishers
- `orgloop inspect module <name>` shows all routes, SOPs, transforms — full transparency before install
- Scoped credentials: modules cannot access env vars they don't declare in their manifest

**Design considerations:**
- SOPs are markdown files — they're inspectable but not machine-verifiable for safety
- The real risk is social engineering: a malicious SOP could instruct an actor to exfiltrate data or take destructive actions
- Mitigation layers: manifest-declared permissions, human review of SOPs, actor-side guardrails (OrgLoop routes, actors enforce)
- This intersects with FE-17 (orgctl) for credential scoping

**Affects:** `packages/sdk/src/module.ts` (manifest schema), `packages/cli/src/commands/add.ts` (install flow), `packages/core/src/module.ts` (permission enforcement)

---

### FE-23: Delivery Journal (Idempotent Re-delivery)

**Gap:** If OrgLoop adds WAL replay (re-processing unacked events after crash recovery), the delivery pipeline needs idempotency. Currently, an event replayed from the WAL could be delivered to an actor twice. The dedup transform doesn't help here — it's a source-level dedup (prevents the same external event from being polled twice), not a delivery-level dedup.

**Architectural decision (WQ-95):** Source dedup and delivery dedup are deliberately separate concerns:

1. **Source dedup** (transforms/dedup) — prevents the same external event from entering the pipeline twice. Time-window based, in-memory, reset on restart. This is correct: the checkpoint already prevents most re-polls, and the dedup window is a safety net. Re-delivering a few events after restart is acceptable (actors should be idempotent per OrgLoop's design philosophy).

2. **Delivery journal** (future, in Runtime) — tracks `(event_id, route, actor)` tuples to ensure at-most-once delivery per route. This belongs in `packages/core/src/runtime.ts`, not in the dedup transform. It should be a persistent store (file-based, alongside the WAL) that the Runtime consults before calling `actor.deliver()`.

**Why not persist the dedup transform?** Adding persistence to the dedup transform would conflate two concerns. The dedup transform answers "have I seen this event key before?" while the delivery journal answers "have I delivered this specific event to this specific actor?" These have different key spaces, different lifetimes, and different consistency requirements.

**Intended solution:**
- Add `DeliveryJournal` interface to core with `hasDelivered(eventId, route, actor)` and `recordDelivery(eventId, route, actor)` methods
- File-based implementation alongside the WAL
- Runtime checks journal before `deliverToActor()` — skip if already delivered
- Journal compacted periodically (entries older than event retention window)
- Opt-in via config: `delivery: { journal: true }` on routes that need exactly-once semantics

**Affects:** `packages/core/src/runtime.ts`, `packages/core/src/store.ts` (new DeliveryJournal), `packages/sdk/src/types.ts` (route config)

---

### FE-24: Daemon Supervisor & Health Monitoring

**Gap:** OrgLoop daemon has no automatic restart capability. If the process crashes due to an uncaught exception, OOM, or signal, manual intervention is required.

**Implemented (WQ-93):**
- `Supervisor` class in `packages/core/src/supervisor.ts` — wraps child process fork with exponential backoff restart
- Crash handlers (`uncaughtException`, `unhandledRejection`) in Runtime — attempt graceful shutdown before exit
- Health heartbeat file (`~/.orgloop/heartbeat`) — written every 30s with timestamp, PID, uptime
- `--supervised` flag on `orgloop start --daemon` to enable supervisor wrapper
- Crash loop detection: max 10 restarts within 5-minute window

**Future improvements:**
- Integration with systemd/launchd for OS-level supervision
- Health check HTTP endpoint (`GET /control/health`) with liveness/readiness semantics
- Watchdog pattern: supervisor reads heartbeat file and force-restarts wedged processes
- Graceful degradation: shed load when sources are unhealthy rather than crashing

**Affects:** `packages/core/src/supervisor.ts`, `packages/core/src/runtime.ts`, `packages/cli/src/commands/start.ts`

---

*This appendix is committed to the repo. Actionable work items referencing these IDs are tracked in `local/WORK_QUEUE.md` (gitignored, private sprint queue).*
