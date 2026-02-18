---
title: "Maturity Roadmap"
description: "Five-phase roadmap from bootstrap to launch, plus connector maturity and orchestrator vision."
---

### The Goal

OrgLoop's aspirational launch story: *"You can install my engineering organization. Here's the YAML. Run this CLI."*

The manifesto ends with that promise. Everything below is the path to making it real.

### Phase 1: Bootstrap Project

**Scaffolding, core runtime, CLI.**

- Monorepo setup (pnpm workspaces, Turborepo, Biome)
- `@orgloop/core` — event bus (in-memory + file WAL), router, transform pipeline, logger fan-out
- `@orgloop/sdk` — plugin interfaces, base classes, test harnesses for connectors, transforms, loggers
- `@orgloop/cli` — `init`, `validate`, `plan`, `start`, `stop`, `status`, `logs`, `test`, `add`, `env`, `doctor`, `routes`, `hook`, `inspect`, `install-service`, `service`, `version`
- YAML schema + JSON Schema validation
- Checkpoint persistence (file-based)
- Built-in transforms: `filter` (jq-based), `dedup`, `enrich`, shell script executor
- Built-in loggers: `file` (JSONL), `console`, `otel` (OpenTelemetry), `syslog`

**Exit criteria:** `orgloop init && orgloop validate && orgloop start` works end-to-end with a mock connector.

### Phase 2: Migrate Bespoke Scripts

**Build GitHub, Linear, Claude Code, OpenClaw connectors.**

- `@orgloop/connector-github` — poll-based, PR activity, CI status
- `@orgloop/connector-linear` — poll-based, ticket state changes
- `@orgloop/connector-claude-code` — hook-based, exit notifications
- `@orgloop/connector-openclaw` — webhook target, agent wake
- `@orgloop/connector-webhook` — generic inbound/outbound
- Migrate each script one at a time: build -> test -> hard cut over -> clean up
- Launch prompt delivery (`with.prompt_file`) working end-to-end

**Exit criteria:** Every existing bespoke script has been replaced by an OrgLoop connector. The old LaunchAgent plists are deleted.

### Phase 3: Operate on OrgLoop

**Run OrgLoop on its own org. Validate.**

- Dog-food the system: run your actual engineering org entirely on OrgLoop
- Harden based on real-world failure modes (crash recovery, checkpoint drift, delivery retries)
- Tune transforms, refine SOPs, iterate on the route configuration
- Validate the success criteria: parity, latency, reliability, recovery, developer experience
- Build observability: `orgloop status` tells the full story of the org's operational health
- Publish `@orgloop/cli` to npm — the first public release

**Exit criteria:** 30 days of stable, unattended operation. Zero dropped events. Recovery from process crashes without manual intervention.

### ~~Phase 4: Package-Native Project Model~~ **Complete**

The project model is package-native. Projects use `package.json` + `orgloop.yaml` with standard npm dependency management. A module system was briefly implemented in v0.1.8 and removed in v0.1.9 in favor of this simpler approach.

- `examples/engineering-org/` — the reference project (GitHub, Linear, Claude Code, OpenClaw)
- `examples/minimal/` — simplest possible project (webhook -> webhook)

**Exit criteria:** Met. `orgloop init` scaffolds a working project. Connectors install via `npm install`.

### Phase 5: Launch

**"Install my engineering organization right now."**

The killer demo: the manifesto ends with a live demonstration. You read the manifesto. You're convinced. Then:

```bash
npm install -g @orgloop/cli
orgloop init --name my-org --connectors github,linear,openclaw,claude-code --no-interactive
cd my-org && npm install
# Set env vars: GITHUB_TOKEN, LINEAR_API_KEY, OPENCLAW_WEBHOOK_TOKEN
orgloop env                     # Verify credentials
orgloop validate                # Check config
orgloop start
```

Your engineering organization is running. GitHub events route to your agent. CI failures wake your supervisor. PR reviews trigger focused SOPs. Linear tickets flow through transforms. Everything is auditable, deterministic, and version-controlled.

That's the launch. That's what we're racing toward.

**Launch artifacts:**
- Published npm packages: `@orgloop/cli`, `@orgloop/core`, `@orgloop/sdk`, all first-party connectors and transforms
- Documentation site at orgloop.ai
- The manifesto, updated with the live demo
- Content series: blog posts, social, community launch

### Beyond Launch: Connector Maturity & the Orchestrator

After launch, DX deepens through two independent tracks:

**Track A: Connector Maturity (organic)**

Connectors progress through stages (see [Scope Boundaries](./scope-boundaries/)):

| Stage | Capability | User experience |
|---|---|---|
| 1. Functional | source/target works | "Set GITHUB_TOKEN and run start" |
| 2. Discoverable | setup metadata, validators | "GITHUB_TOKEN -- create at github.com/settings/tokens" |
| 3. Self-service | credential acquisition | "Authenticate via browser? (Y/n)" |

Each first-party connector matures at its own pace. GitHub (well-established OAuth) may reach Stage 3 before OpenClaw (local service, evolving API).

**Track B: Environment Orchestrator (sister project)**

`orgctl` reads the project config and connector setup metadata to handle what OrgLoop doesn't: service installation, credential brokering, cross-system configuration.

```bash
orgctl bootstrap --template engineering-org --github-repo my-org/my-repo
# Blank machine → running autonomous engineering org
```

See the [orgctl RFP](https://orgloop.ai/vision/orgctl/) for the full project specification. orgctl depends on OrgLoop's stable interfaces (`orgloop doctor --json`, `--non-interactive` flags, connector setup metadata) but has its own release cadence and project scope.
