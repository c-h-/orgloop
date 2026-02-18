# OrgLoop

[![CI](https://github.com/c-h-/orgloop/actions/workflows/ci.yml/badge.svg)](https://github.com/c-h-/orgloop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)
[![Docs](https://img.shields.io/badge/docs-orgloop.ai-blue)](https://orgloop.ai)

**Organization as Code -- declarative event routing for autonomous AI organizations.**

🧬 OrgLoop is a declarative runtime for autonomous AI organizations. You define event sources, actors, routes, and standard operating procedures in YAML. When a PR merges, a customer emails, or Claude Code stops working, OrgLoop matches the event to a route and wakes the right actor with a focused prompt for exactly what to do.

When that actor finishes, its completion fires an event back into the system, and the loop continues. Events are generated programmatically and flow through deterministic routing, not chat threads. You are not dependent on a heartbeat eventually finding the right state, an Agent remembering to call a tool, nor a patrol coming across something important.

OrgLoop is open-ended and open source. Build your organization with all of your specialized agents: Claude Code implementers, OpenClaw supervisors, Deep Research lone wolves. Connect GitHub, Linear, Gmail, whatever. There are pre-built connectors, and they're easy to contribute. Tune all your business processes, information flows, and event handling in one place.

> You don't need reliable actors if you have a reliable system around them.

AI agents forget, idle, rabbit-hole, drop context. OrgLoop doesn't fix the agents -- it makes the *system* reliable. **The org loops.**

```
Source -> [Transform] -> Route -> Actor
   ^                              |
   +------ actor.stopped ---------+
```

**[Documentation](https://orgloop.ai)** | **[Getting Started](https://orgloop.ai/start/getting-started/)** | **[Spec](https://orgloop.ai/spec/)**

---

## Try It

Set up a webhook source and a console logger, then route an event between them.

```bash
npm install -g @orgloop/cli
orgloop init    # select "webhook" when prompted for connectors
cd my-org
npm install
orgloop start
```

In another terminal, send an event:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"type": "test", "message": "hello from orgloop"}'
```

You should see the event flow through the system and appear in your console log. That's the core loop: source emits, route matches, actor delivers, logger observes.

---

## What It Grows Into

When you're ready to wire up real services, OrgLoop scales to a full engineering organization:

```bash
orgloop init    # select github, linear, claude-code, openclaw
cd my-org
npm install
orgloop doctor        # Check deps + credentials
orgloop plan          # Preview what will run
orgloop start         # Start the runtime
orgloop status        # See everything flowing
```

```
OrgLoop Runtime
  Status: running (PID 42891)
  Uptime: 3h 22m
  Control API: http://127.0.0.1:4800

  Sources: 3 | Actors: 1 | Routes: 3

  SOURCE       HEALTH    LAST POLL   ERRORS  EVENTS
  github       healthy   2m ago      0       47
  linear       healthy   3m ago      0       12
  claude-code  healthy   18m ago     0       3
```

**Prerequisites for the full engineering workflow:**

- Node.js >= 22
- GitHub account + [personal access token](https://github.com/settings/tokens) with `repo` read access
- Linear account + [API key](https://linear.app/settings/api)
- Claude Code installed locally
- OpenClaw running locally

See the **[Getting Started guide](https://orgloop.ai/start/getting-started/)** for step-by-step setup.

---

## Five Primitives

Your org topology as a project:

```
my-org/
  package.json              # @orgloop/* dependencies
  orgloop.yaml              # Project config: references connector, route, transform, logger files
  connectors/
    github.yaml             # Source: GitHub repository events
    openclaw.yaml           # Actor: OpenClaw agent delivery
  routes/
    engineering.yaml        # Route: events → engineering agent
  transforms/
    transforms.yaml         # Transform definitions
    drop-bot-noise.sh       # Script transform
  loggers/
    default.yaml            # File logger config
  sops/
    pr-review.md            # Launch prompt for PR review events
```

```yaml
# orgloop.yaml
apiVersion: orgloop/v1alpha1
kind: Project

metadata:
  name: my-org
  description: "Engineering event routing"

connectors:
  - connectors/github.yaml
  - connectors/openclaw.yaml

transforms:
  - transforms/transforms.yaml

loggers:
  - loggers/default.yaml
```

**Sources** emit events. **Actors** do work. **Routes** wire them. **Transforms** filter/enrich. **Loggers** observe everything.

---

## Why OrgLoop

- **Event-driven actor model** -- sources may poll, but actors never do. Actors wake only when a matched event arrives — no timers, no scanning, no idle loops.
- **Declarative topology** -- your org's wiring lives in version control
- **Recursive loop** -- actor completion feeds back as events, triggering the next cycle
- **Pluggable everything** -- swap GitHub for GitLab, OpenClaw for a custom agent
- **Transforms for security** -- injection scanning, bot noise filtering, rate limiting
- **Full observability** -- every event, transform, delivery logged and traceable
- **One process replaces N pollers** -- no more scattered LaunchAgents and cron jobs
- **Daemon mode** -- supervised background process with auto-restart
- **`plan` before `start`** -- see exactly what will change (Terraform-style)

---

## Test & Debug

```bash
# Visualize your routing topology
orgloop routes

# Inject a test event and trace its path
orgloop test event.json

# Inspect any primitive
orgloop inspect source github
orgloop inspect route github-to-engineering

# Tail logs with filters
orgloop logs --source github --since 2h
```

---

## Packages (21)

| Package | Description |
|---------|-------------|
| `@orgloop/sdk` | Interfaces, types, test harness |
| `@orgloop/core` | Runtime, router, bus, scheduler, schema validation |
| `@orgloop/cli` | CLI (`init`, `plan`, `start`, `status`, `doctor`, ...) |
| `@orgloop/server` | HTTP API server |
| `@orgloop/connector-github` | Poll-based: PRs, reviews, CI, comments |
| `@orgloop/connector-linear` | Poll-based: issues, comments, state changes |
| `@orgloop/connector-claude-code` | Hook-based: post-exit session events |
| `@orgloop/connector-openclaw` | Target: POST delivery to OpenClaw agents |
| `@orgloop/connector-webhook` | Generic: source (HMAC) + target (HTTP) |
| `@orgloop/connector-cron` | Scheduled: cron expressions + intervals |
| `@orgloop/transform-filter` | Match/exclude with dot-path patterns |
| `@orgloop/transform-dedup` | SHA-256 hash, time window dedup |
| `@orgloop/transform-enrich` | Add, copy, and compute fields on events |
| `@orgloop/logger-console` | ANSI colors, phase icons, level filtering |
| `@orgloop/logger-file` | Buffered JSONL, rotation, gzip |
| `@orgloop/logger-otel` | OpenTelemetry OTLP export |
| `@orgloop/connector-agent-ctl` | Agent lifecycle control (start, stop, signal) |
| `@orgloop/connector-docker` | Docker container events and management |
| `@orgloop/connector-gog` | GOG integration connector |
| `@orgloop/transform-agent-gate` | Agent gating logic for event pipelines |
| `@orgloop/logger-syslog` | RFC 5424 syslog protocol |

---

## Status

Alpha. The concepts behind OrgLoop have been running in production since January 2026 — managing a real engineering organization with GitHub, Linear, Claude Code, and OpenClaw. The framework is being extracted and formalized from that system.

If this is interesting to you, star and watch the repo. Contributions welcome.

## Contributing

See [AGENTS.md](AGENTS.md) for build instructions, architecture, and code style. The docs site lives in `docs-site/` (Astro Starlight) — run `cd docs-site && npm run dev` to preview locally. The engineering spec is published alongside user docs at [orgloop.ai/spec/](https://orgloop.ai/spec/).

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

[MIT License](LICENSE.md)

---

Built by [Charlie Hulcher](https://github.com/c-h-) — running in production at [Kindo](https://kindo.ai).
