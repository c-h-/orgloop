# AGENTS.md — OrgLoop 🧬

Guidance for Claude Code and AI agents working in this repository.

## What is OrgLoop

OrgLoop is an **Organization as Code** framework — a declarative event routing system for autonomous AI organizations. It replaces scattered cron jobs and shell scripts with a unified, event-driven runtime.

Five primitives: **Sources** emit events, **Actors** do work, **Routes** wire them together, **Transforms** filter/enrich in the pipeline, **Loggers** observe everything. Actor completion feeds back as events, creating a recursive loop.

Core insight: *You don't need reliable actors if you have a reliable system around them.*

## DX Philosophy: Progressive Delight

OrgLoop's developer experience follows a principle of **progressive delight** — every user-facing surface should reduce friction one layer at a time. When you encounter a DX surface, ask: *what's the next thing the user will be confused about?* Then eliminate that confusion before they feel it.

**The progression pattern (env vars as example):**

1. **Level 0 — Silent failure.** User runs `start`, gets a cryptic crash. *Never ship this.*
2. **Level 1 — Tell them what they need.** List required env vars after scaffolding. *Minimum viable.*
3. **Level 2 — Tell them what they have.** Show ✓/✗ status per var with colors. *Awareness.*
4. **Level 3 — Tell them how to fix it.** Connector-provided helper text: description, URL, one-liner command. *Actionable guidance.*
5. **Level 4 — Fix it for them.** OAuth flows, credential acquisition, service detection. *Delight.*

**We are always climbing this ladder.** Every CLI output, every error message, every onboarding step should be at least Level 3. Level 4 is the aspiration — connectors mature into it.

**Applying this in practice:**

- **Error messages:** Never just say what failed. Say what to do about it. Include the URL, the command, the config field name.
- **Connector setup metadata:** Every connector SHOULD populate `ConnectorSetup` with `env_vars` (including per-var `description` and `help_url`). This is how the CLI knows what guidance to show.
- **Pre-flight over post-mortem.** Validate env vars in `validate` and `plan`, not just `start`. Never let the user get to a late stage before discovering an early problem.
- **Actionable defaults.** If a command can suggest a next step, it should. `orgloop init` → "run `orgloop env` to check your variables." `orgloop env` shows missing vars with setup instructions. `orgloop validate` → "all clear, run `orgloop start`."
- **Machine-readable alongside human-readable.** Every status/check command should support `--json` for automation, CI, and tool integration.

This philosophy is what made OpenClaw successful. Delight compounds. Every friction point removed makes the next one more noticeable — and more worth fixing.

## Build & Development

```bash
pnpm install              # Install deps (pnpm 9.15.4, Node >=22)
pnpm build                # Build all packages (turbo, respects dependency order)
pnpm test                 # Run all tests (vitest via turbo)
pnpm lint                 # Check code style (biome)
pnpm lint:fix             # Auto-fix formatting + imports
pnpm typecheck            # TypeScript type checking across workspace
pnpm clean                # Clean all dist/ directories
```

### Single package

```bash
cd packages/core && npx vitest run          # One package's tests
npx vitest run packages/core/src/__tests__/router.test.ts  # One test file
```

### Before you push

```bash
pnpm build && pnpm test && pnpm typecheck && pnpm lint
```

All four must pass. CI runs these on every PR.

## Monorepo Structure

pnpm workspaces + Turborepo. Four workspace roots:

```
packages/
  sdk/          — Interfaces, types, test harness (MockSource, MockActor, etc.)
  core/         — Engine, router, bus, scheduler, schema validation, transform pipeline
  cli/          — Commander-based CLI (init, validate, plan, start, status, logs, test, etc.)
  server/       — HTTP API server (placeholder)

connectors/
  coding-agent/ — Hook-based: harness-agnostic webhook receiver for any coding agent
  github/       — Poll-based: PR reviews, comments, CI failures, bot detection
  linear/       — Poll-based: GraphQL, state change detection, comments
  claude-code/  — Backward-compat alias for coding-agent (delegates to coding-agent)
  openclaw/     — Target: POST delivery to OpenClaw agent webhooks
  webhook/      — Generic: source (HMAC validation) + target (configurable HTTP)
  cron/         — Scheduled: cron expressions + interval syntax

transforms/
  filter/       — Match/exclude with dot-path patterns + jq mode
  dedup/        — SHA-256 hash, time window, periodic cleanup
  enrich/       — Add, copy, and compute fields on events

loggers/
  console/      — ANSI colors, phase icons, level filtering
  file/         — Buffered JSONL, rotation (size/age/count), gzip
  otel/         — OpenTelemetry OTLP export
  syslog/       — RFC 5424 syslog protocol
```

**Dependency chain:** `sdk` → `core` → everything else. Turbo handles this via `"dependsOn": ["^build"]`.

## Architecture

### Event flow

```
Source.poll() → EventBus → ModuleInstance.processEvent() → matchRoutes() → executeTransformPipeline() → Actor.deliver()
                                                                                                              |
                                                                                                    actor.stopped → EventBus (loops back)
```

The `Runtime` owns the shared infrastructure (bus, scheduler, loggers, HTTP server). Each `ModuleInstance` owns its sources, actors, routes, and transforms. Events flow through module-scoped routing -- each module only matches against its own routes. The bus is the spine. Routes are explicit allow-lists (actors only see events their routes match).

### Key classes

| Class | File | Role |
|-------|------|------|
| `Runtime` | `packages/core/src/runtime.ts` | Multi-module runtime. Owns bus, scheduler, registry, HTTP control server. |
| `ModuleInstance` | `packages/core/src/module-instance.ts` | Per-module resource container. Sources, actors, transforms, lifecycle (loading/active/unloading/removed). |
| `ModuleRegistry` | `packages/core/src/registry.ts` | Singleton module name registry. Prevents conflicts. |
| `OrgLoop` | `packages/core/src/engine.ts` | Backward-compatible wrapper around Runtime. Single-module convenience API. |
| Daemon Client | `packages/cli/src/daemon-client.ts` | HTTP client for communicating with a running daemon's control API. |
| Module Registry (CLI) | `packages/cli/src/module-registry.ts` | Persistent module tracking (`~/.orgloop/modules.json`). Maps directories to loaded modules across CLI commands. |
| `matchRoutes()` | `packages/core/src/router.ts` | Dot-path filtering, multi-route matching |
| `executeTransformPipeline()` | `packages/core/src/transform.ts` | Sequential transforms, fail-open default |
| `Scheduler` | `packages/core/src/scheduler.ts` | Poll intervals, graceful start/stop |
| `InMemoryBus` / `FileWalBus` | `packages/core/src/bus.ts` | Pluggable event bus (WAL for durability) |
| `loadConfig()` | `packages/core/src/schema.ts` | YAML loading, AJV validation, env var substitution |
| `FileCheckpointStore` | `packages/core/src/store.ts` | Source deduplication checkpoints |
| `LoggerManager` | `packages/core/src/logger.ts` | Fan-out to loggers, non-blocking, error-isolated |

### Plugin registration

Every connector, transform, and logger exports a `register()` function:

```typescript
// Connector: ConnectorRegistration { id, source?, target?, configSchema, setup }
// Transform: TransformRegistration { id, transform, configSchema }
// Logger:    LoggerRegistration { id, logger, configSchema }
```

To build a new connector: implement `SourceConnector` (for sources) or `ActorConnector` (for targets) from `@orgloop/sdk`, export `register()`, publish as `orgloop-connector-<name>`. See any existing connector for the pattern.

### Plugin wiring chain — CRITICAL

Every plugin type (connector, transform, logger) must be wired through the **full chain**. Missing any link = silent failure at runtime.

```
1. package.json dep    — @orgloop/cli must list the package as a dependency
2. Dynamic import      — start.ts imports the package and calls register()
3. Runtime.loadModule() — resolved instance passed via module options
4. ModuleInstance.initialize() — init() called with config from YAML
```

**Past bugs from broken chains:**
- Loggers never created log files (missing steps 1–4)
- Package transforms silently skipped (missing steps 2–3)
- Config field names in YAML didn't match connector interfaces (step 4 failed silently)

**When adding a new plugin package:** wire all 4 steps, add a test in `engine-integration.test.ts`, and add the package to `packages/cli/package.json` devDependencies.

### Path handling in config

- Node's `resolve()` does NOT expand `~`. Use `path.startsWith('~/') ? path.replace('~', homedir()) : path`
- Relative paths in YAML resolve relative to the file containing them, NOT the project root
- `validate.ts` and `config.ts` must agree on path resolution

### SDK test harness

`@orgloop/sdk` exports: `MockSource`, `MockActor`, `MockTransform`, `MockLogger`, `createTestEvent()`, `createTestContext()`. Use these in all tests.

### Test coverage

| Area | File | Tests |
|------|------|-------|
| Engine wiring (sources, actors, transforms, loggers) | `packages/core/src/__tests__/engine-integration.test.ts` | 7 |
| Config loading + env var substitution | `packages/cli/src/__tests__/config-loading.test.ts` | 7 |
| Connector resolution | `packages/cli/src/__tests__/resolve-connectors.test.ts` | 7 |
| Connector config field compatibility | `packages/cli/src/__tests__/connector-config-compat.test.ts` | 40 |
| Coding agent (harness-agnostic) lifecycle | `connectors/coding-agent/src/__tests__/source.test.ts` | 30 |
| Claude Code backward compat | `connectors/claude-code/src/__tests__/source.test.ts` | 4 |
| Codex lifecycle conformance | `connectors/codex/src/__tests__/source.test.ts` | 26 |
| OpenCode lifecycle conformance | `connectors/opencode/src/__tests__/source.test.ts` | 26 |
| Pi lifecycle conformance | `connectors/pi/src/__tests__/source.test.ts` | 26 |
| Pi-rust lifecycle conformance | `connectors/pi-rust/src/__tests__/source.test.ts` | 26 |
| Router matching | `packages/core/src/__tests__/router.test.ts` | — |
| Event bus | `packages/core/src/__tests__/bus.test.ts` | — |
| Checkpoint store | `packages/core/src/__tests__/store.test.ts` | — |
| Transform filter | `transforms/filter/src/__tests__/filter.test.ts` | — |
| Dedup transform | `transforms/dedup/src/__tests__/dedup.test.ts` | — |
| Daemon lifecycle (PID, signals, stop, logs, state) | `packages/cli/src/__tests__/daemon-lifecycle.test.ts` | 45 |
| Runtime lifecycle (multi-module, shared infra) | `packages/core/src/__tests__/runtime.test.ts` | 11 |
| Module registry (name conflicts, lookup) | `packages/core/src/__tests__/registry.test.ts` | 8 |
| Module instance (lifecycle states, resource ownership) | `packages/core/src/__tests__/module-instance.test.ts` | 17 |
| Multi-module runtime (load, unload, reload, events) | `packages/core/src/__tests__/multi-module-runtime.test.ts` | 9 |
| Module registry CLI (persist, find, clear) | `packages/cli/src/__tests__/module-registry.test.ts` | 12 |

When fixing a bug, add a regression test. When wiring a new plugin, add an engine-integration test.

## Event Taxonomy

Three event types — minimal by design, always additive:

| Type | Meaning |
|------|---------|
| `resource.changed` | Something changed in an external system (PR, ticket, CI, deploy) |
| `actor.stopped` | An actor's session ended (no claim about success/failure — payload carries details) |
| `message.received` | A human or system sent a message |

**`actor.stopped` is deliberately neutral.** OrgLoop observes that a session ended. Whether work was completed, the agent crashed, got stuck, or lied about finishing — that's for the receiving actor to judge. OrgLoop routes signals; actors have opinions.

Event IDs: `evt_` prefix. Trace IDs: `trc_` prefix. Payload is connector-specific (freeform JSON). The envelope is generic (id, timestamp, source, type, provenance).

## ⚠️ Documentation Is a Ship Requirement

**No PR is complete without updating all affected documentation.** This is not optional — OrgLoop's value depends entirely on people's ability to understand and use it. Shipping code without documentation is a failed delivery.

### The Rule

Every PR that changes behavior, config, CLI, architecture, or project structure MUST also update:

1. **Docs website** (`docs-site/src/content/docs/`) — user-facing guides, concepts, references, examples
2. **Spec files** (`docs-site/src/content/docs/spec/`) — design specification
3. **README files** (root `README.md`, connector/package READMEs) — quick-start and overview
4. **AGENTS.md** (this file) — if the change affects how agents work in this repo

### What "affected documentation" means

- **New feature/connector/transform** → new docs page + getting-started update + README + spec update
- **Changed config schema** → reference/config-schema.md + spec/config-schema.md + examples
- **Changed CLI behavior** → cli/command-reference.md + spec/cli-design.md
- **Removed/renamed concept** → update EVERY page that references it (grep the docs-site directory)
- **Changed project structure** → spec/repo-organization.md + getting-started + README

### How to verify

Before opening a PR, grep the docs for any terms you changed:
```bash
grep -r "old_term" docs-site/src/content/docs/ README.md */README.md
```
If there are hits, update them. Zero tolerance for stale docs.

### Why this exists

We shipped multiple PRs (package-native model, daemon resilience, smart polling) without updating the docs website or READMEs. The docs still reference removed concepts (modules). This erodes trust in the project. It stops here.

---

## Spec Sync

The [specification](https://orgloop.ai/spec/) is the source of truth for OrgLoop's design. Spec files live in `docs-site/src/content/docs/spec/`. When making structural changes (adding/removing/renaming primitives, changing interfaces, altering event flow, modifying config schema):

1. **Read** the relevant spec files first — understand the intended design
2. **Make** your code changes
3. **Update** the spec to reflect what changed

If the spec and code disagree, resolve the conflict — don't leave them diverged.

Key spec files:
- [Event Schema](https://orgloop.ai/spec/event-schema/) — Event types and JSON schema
- [Plugin System](https://orgloop.ai/spec/plugin-system/) — Connector/transform/logger plugin model, setup metadata
- [CLI Design](https://orgloop.ai/spec/cli-design/) — CLI commands and behavior (including `env`, `doctor`)
- [Runtime Modes](https://orgloop.ai/spec/runtime-modes/) — Runtime modes (CLI, library, server)
- [Scope Boundaries](https://orgloop.ai/spec/scope-boundaries/) — What OrgLoop does vs. doesn't do, connector maturity, orchestrator vision
- [Future Extensions](https://orgloop.ai/spec/future-extensions/) — Design gaps and planned capabilities (FE-XX)
- [orgctl RFP](https://orgloop.ai/vision/orgctl/) — Sister project specification for environment bootstrapping

## Code Style

- **Biome** — tabs (2-width), single quotes, semicolons, trailing commas, line width 100
- **Pure ESM** — `"type": "module"` everywhere, `verbatimModuleSyntax: true`
- **Vitest** — globals enabled (no need to import `describe`/`it`/`expect`)
- **Tests** colocated in `src/__tests__/*.test.ts`
- **Config** uses `env:VAR_NAME` syntax for environment variable substitution in YAML
- Keep files focused. Extract helpers. Aim for <500 LOC per file.
- Brief comments for non-obvious logic. Types speak for themselves.

## Commit & PR Conventions

- **Commit messages:** conventional commits — `feat(scope): description`, `fix(core): description`, `docs: description`
- **Scope:** package name (`sdk`, `core`, `cli`, `connector-github`, `transform-filter`, etc.)
- **One concern per commit.** Don't bundle unrelated changes.
- **Branch naming:** `feat/<name>`, `fix/<name>`, `docs/<name>`
- **PRs:** summarize scope, note testing performed, mention user-facing changes
- **AI-assisted PRs welcome** 🤖 — mark as AI-assisted, note testing degree, confirm you understand the code

## Connector Development Guide

### Building a source connector

1. `orgloop add connector my-source --type source` (scaffolds the package)
2. Implement `SourceConnector` from `@orgloop/sdk`:
   - `init(config)` — set up API clients, validate credentials
   - `poll(checkpoint)` → `{ events, checkpoint }` — fetch new events since last checkpoint
   - `shutdown()` — cleanup
3. Implement `register()` exporting a `ConnectorRegistration`
4. Write tests using `createTestEvent()` and `createTestContext()` from SDK
5. Add a `README.md` (install, config, events emitted, example route)
6. Publish as `orgloop-connector-<name>` on npm

### Building a target connector

Same pattern, but implement `ActorConnector`:
- `init(config)` — set up client
- `deliver(event)` → `{ success, error? }` — deliver event to the target system
- `shutdown()` — cleanup

### Building a transform

Script-based (stdin/stdout, any language) or package-based (TypeScript, implements `Transform`):
- Receives event on stdin (script) or as argument (package)
- Returns modified event, or null/exit-1 to drop
- Transforms are sequential — order matters in the pipeline

## Security Model

- **Polling over webhooks** — zero inbound attack surface by default
- **Transforms for injection defense** — inspect payloads before they reach actors
- **Env var substitution** — secrets never live in YAML (`${GITHUB_TOKEN}`)
- **Least-privilege routing** — actors only see events their routes match
- **Audit by default** — loggers are first-class primitives, not optional
- **Plan before start** — `orgloop plan` shows changes before execution

See the [Security guide](https://orgloop.ai/guides/security/) for the full security architecture.

## Local Development Files

The `local/` directory is gitignored — use it for:
- `WORK_QUEUE.md` — current task queue and requirements
- `STATUS.md` — implementation tracking
- `WAITING_FOR_HUMAN.md` — items requiring human input
- Scratch files, experiment configs, test outputs

## Examples

`examples/` contains self-contained example projects:
- `minimal/` — simplest possible setup (1 source, 1 actor, 1 route)
- `engineering-org/` — full engineering org (GitHub, Linear, Claude Code → OpenClaw)
- `github-to-slack/` — single source → single actor, 2-minute setup
- `multi-agent-supervisor/` — Claude Code supervision pattern

Each example is a self-contained project you can copy and run.

## Tracking Work — SOP

**Never drop a found issue or feature idea on the floor.** Every gap discovered during development must be captured immediately.

### Where things go

| What you found | Where it goes |
|----------------|--------------|
| **Design gap** (interface change, new capability, spec extension) | `docs-site/src/content/docs/spec/future-extensions.md` (FE-XX) + `local/WORK_QUEUE.md` (WQ-XX) |
| **Implementation bug** (config mismatch, broken wiring) | Fix now. If you can't, add to `local/WORK_QUEUE.md` |
| **Feature idea** (new connector, CLI improvement, DX) | `local/WORK_QUEUE.md` (WQ-XX). If it's a design-level change, also add to the future extensions appendix |
| **Spec divergence** (code disagrees with spec) | Fix immediately. Read spec → fix code or update spec. Don't leave them diverged. |

### Two files, one system

- **`docs-site/src/content/docs/spec/future-extensions.md`** (committed) — Design rationale. WHY something is needed, WHAT the solution looks like. Public, for contributors. FE-XX IDs.
- **`local/WORK_QUEUE.md`** (gitignored) — Sprint queue. WHEN to build it, HOW to prioritize. Private, for the current developer. WQ-XX IDs.

FE items describe the design. WQ items reference FE IDs but track the actionable work. Don't duplicate the design detail in WQ — just reference the FE-XX.

### Post-push

When the repo is on GitHub, migrate backlog items to GitHub Issues with labels:
- `design-gap` — FE-XX items
- `feature` — New capabilities
- `bug` — Implementation issues
- `dx` — Developer experience improvements
- `connector-request` — New connector ideas

### During development

When you encounter a gap or idea while working:
1. **Pause.** Don't keep going and forget it.
2. **Capture it** in the right place (see table above).
3. **Resume** your current task.

This takes 30 seconds and prevents hours of re-discovery later.

## What NOT to Do

- Don't add event types without updating the spec and this file
- Don't put secrets in YAML — use `${ENV_VAR}` substitution
- Don't commit `dist/`, `node_modules/`, or `.turbo/`
- Don't make connectors assume payload shapes from other connectors — payloads are connector-specific
- Don't interpret `actor.stopped` as success or failure — that's the receiving actor's job

## Quality Gate — MANDATORY Before Declaring Done

**The work is not done until ALL of these pass:**

1. `pnpm run typecheck` — zero errors
2. `pnpm run lint` — zero errors
3. `pnpm run build` — succeeds (turbo build across all packages)
4. `pnpm test` — all tests pass
5. **New logic requires new tests.** If you added or changed a function, write a test for it.
6. **If you can't make tests pass, say so explicitly.** Do not silently skip failing tests.

### For UI/web work (docs-site, future dashboards):
- Start the dev server
- Use Playwright MCP to screenshot affected pages
- Visually verify the output matches the intent
- Iterate until correct — do not declare done without visual evidence

### Anti-Patterns — DO NOT:
- ❌ Commit without running the full verify suite
- ❌ Skip writing tests for new functionality
- ❌ Declare "done" when tests are failing
- ❌ Assume the code works because it compiles
- ❌ Ship UI changes without visual verification
