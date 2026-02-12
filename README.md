# OrgLoop

[![CI](https://github.com/c-h-/orgloop/actions/workflows/ci.yml/badge.svg)](https://github.com/c-h-/orgloop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)
[![Docs](https://img.shields.io/badge/docs-orgloop.ai-blue)](https://orgloop.ai)

**Organization as Code -- declarative event routing for autonomous AI organizations.**

> You don't need reliable actors if you have a reliable system around them.

AI agents forget, idle, rabbit-hole, drop context. OrgLoop doesn't fix the agents -- it makes the *system* reliable. When a resource changes state, the right actor is woken with the right context. When that actor finishes, its completion is itself an event, routed to the next actor. **The org loops.**

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
orgloop add module minimal
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
orgloop add module engineering
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
  Modules: 1

Module: engineering
  State: active | Uptime: 3h 22m
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

Your entire org topology in one file:

```yaml
# orgloop.yaml
sources:
  - id: github
    connector: "@orgloop/connector-github"
    config:
      repo: "my-org/my-repo"
      token: "${GITHUB_TOKEN}"
    poll: { interval: 5m }

  - id: claude-code
    connector: "@orgloop/connector-claude-code"
    config: { hook_type: post-exit }

actors:
  - id: openclaw-engineering-agent
    connector: "@orgloop/connector-openclaw"
    config:
      base_url: "http://127.0.0.1:18789"
      auth_token_env: "${OPENCLAW_WEBHOOK_TOKEN}"

routes:
  - name: github-to-engineering
    when:
      source: github
      events: [resource.changed]
    transforms:
      - transforms/drop-bot-noise.sh
      - transforms/injection-scanner.sh
    then: { actor: openclaw-engineering-agent }

  - name: claude-code-to-supervisor
    when:
      source: claude-code
      events: [actor.stopped]
    then: { actor: openclaw-engineering-agent }

loggers:
  - name: file-log
    type: "@orgloop/logger-file"
    config: { path: ./logs/orgloop.log, format: jsonl }
```

**Sources** emit events. **Actors** do work. **Routes** wire them. **Transforms** filter/enrich. **Loggers** observe everything.

---

## Why OrgLoop

- **Event-driven, not cron-driven** -- actors wake when something happens, not on a timer
- **Declarative topology** -- your org's wiring lives in version control
- **Recursive loop** -- actor completion feeds back as events, triggering the next cycle
- **Pluggable everything** -- swap GitHub for GitLab, OpenClaw for a custom agent
- **Transforms for security** -- injection scanning, bot noise filtering, rate limiting
- **Full observability** -- every event, transform, delivery logged and traceable
- **One process replaces N pollers** -- no more scattered LaunchAgents and cron jobs
- **Multi-module runtime** -- load, unload, reload modules without restarting
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

# Module management (hot-load without restarting)
orgloop module list
orgloop module load ./my-module
orgloop module reload engineering
```

---

## Packages (19)

| Package | Description |
|---------|-------------|
| `@orgloop/sdk` | Interfaces, types, test harness |
| `@orgloop/core` | Runtime, module lifecycle, router, bus, scheduler, schema validation |
| `@orgloop/cli` | CLI (`init`, `plan`, `start`, `status`, `module`, `doctor`, ...) |
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
| `@orgloop/logger-syslog` | RFC 5424 syslog protocol |
| `@orgloop/module-engineering` | Engineering workflow: 5 routes, 3 SOPs |
| `@orgloop/module-minimal` | Minimal starter: 1 source, 1 actor, 1 route |

---

## Status

Early release. The concepts behind OrgLoop have been running in production since January 2026 -- managing a real engineering organization with GitHub, Linear, Claude Code, and OpenClaw. The framework is being extracted and formalized from that battle-tested system.

If this is interesting to you, star and watch the repo. Contributions welcome.

## Contributing

See [AGENTS.md](AGENTS.md) for build instructions, architecture, and code style. The docs site lives in `docs-site/` (Astro Starlight) — run `cd docs-site && npm run dev` to preview locally. The engineering spec is published alongside user docs at [orgloop.ai/spec/](https://orgloop.ai/spec/).

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

[MIT License](LICENSE.md)
