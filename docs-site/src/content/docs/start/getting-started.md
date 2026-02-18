---
title: Getting Started
description: Install OrgLoop and route your first event in 2 minutes — then grow into a full autonomous engineering org.
---

OrgLoop has three levels. You can stop at any one and have a working system.

| Tier | Time | What you need | What you get |
|------|------|---------------|--------------|
| **1. See It Work** | ~2 min | Nothing | Event routing with a webhook |
| **2. Connect to GitHub** | ~10 min | GitHub token | Real PR/CI events flowing through OrgLoop |
| **3. Full Engineering Org** | ~30 min | 4 services | Autonomous AI org with supervision loop |

Start at Tier 1. Every tier builds on the one before it.

---

## Tier 1: See It Work

A webhook source, a console logger, one route connecting them.

### Install

```bash
npm install -g @orgloop/cli
```

Verify:

```bash
orgloop version
```

Requires Node.js >= 22.

### Scaffold a project

```bash
orgloop init
```

The wizard prompts for a project name and which connectors to include. Select **webhook** only — that's all you need for this tier.

```bash
cd my-org
```

### Install dependencies and run

```bash
npm install
orgloop validate
orgloop start
```

OrgLoop is now running. The webhook source is listening on `http://localhost:3000/webhook`.

### Send a test event

In another terminal:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"type": "test", "message": "hello from orgloop"}'
```

You should see the event logged to the console:

```
▶ [source:webhook] resource.changed — {"type":"test","message":"hello from orgloop"}
✓ [route:webhook-to-log] matched → console-log
```

**You just routed your first event through OrgLoop.** The webhook received an HTTP POST, the router matched it to a route, and the logger printed it. That's the core loop.

Ready to connect it to real systems? Keep going.

---

## Tier 2: Connect to GitHub

Add a real GitHub source so OrgLoop reacts to PR reviews, comments, and CI failures.

### What you need

One thing: a **GitHub personal access token** with `repo` scope.

Create one here: [github.com/settings/tokens/new?scopes=repo](https://github.com/settings/tokens/new?scopes=repo)

### Set environment variables

```bash
export GITHUB_REPO="your-org/your-repo"
export GITHUB_TOKEN="ghp_..."
```

### Add the GitHub connector

Start fresh with a new project that includes both connectors:

```bash
orgloop init
```

This time, select **github** and **webhook** in the connector picker. The wizard detects your `GITHUB_TOKEN` and shows its status.

### Verify your environment

```bash
orgloop env
```

```
Environment Variables:

  ✓ GITHUB_REPO              connectors/github.yaml
  ✓ GITHUB_TOKEN             connectors/github.yaml
    → GitHub personal access token (repo scope)
    → https://github.com/settings/tokens/new?scopes=repo

2 of 2 variables set. 0 missing.
```

### Run it

```bash
orgloop validate
orgloop start
```

OrgLoop now polls your GitHub repo every 5 minutes. When a PR review comes in or CI fails, you'll see it in the console. Events from GitHub flow through the same routing system as the webhook — sources are interchangeable.

**You now have a real integration.** GitHub events are being polled, routed, and logged. Ready for the full autonomous engineering org? One more tier.

---

## Tier 3: Full Autonomous Engineering Org

This is the complete setup: GitHub, Linear, Claude Code, and OpenClaw working together as an autonomous engineering organization. Events from code reviews, tickets, and dev sessions flow to an AI agent that does the actual work.

### What you need

Four external services. Here's what each one is and why OrgLoop uses it:

| Service | What it is | Why OrgLoop needs it | Get it |
|---------|-----------|---------------------|--------|
| **GitHub** | Code hosting | OrgLoop polls for PR reviews, comments, and CI failures | You already have this from Tier 2 |
| **Linear** | Project management tool | OrgLoop polls for ticket state changes and comments | [Create API key](https://linear.app/settings/api) |
| **Claude Code** | Anthropic's AI coding tool (CLI) | OrgLoop receives session completion hooks — it knows when a dev agent finishes work | [Install Claude Code](https://docs.anthropic.com/en/docs/claude-code) |
| **OpenClaw** | AI agent orchestrator | The "actor" — receives events and does the actual work (code review, triage, etc.) | [OpenClaw setup guide](https://openclaw.com/docs) |

### Set environment variables

```bash
# GitHub (from Tier 2)
export GITHUB_REPO="your-org/your-repo"
export GITHUB_TOKEN="ghp_..."

# Linear
export LINEAR_TEAM_KEY="ENG"
export LINEAR_API_KEY="lin_api_..."

# OpenClaw
export OPENCLAW_WEBHOOK_TOKEN="your-token-here"
```

Claude Code doesn't need an env var — OrgLoop receives hooks directly from the Claude Code CLI via its post-exit hook mechanism.

### Scaffold the full project

```bash
orgloop init
```

Select **github**, **linear**, **openclaw**, and **claude-code** in the connector picker. The wizard will also offer to install the Claude Code post-exit hook.

```bash
cd my-org
npm install
```

The scaffolded project includes pre-built routes for PR review, PR comment response, CI failure triage, Linear ticket routing, and Claude Code supervision. You can customize routes, transforms, and SOPs in the project files as needed.

### Check your environment

```bash
orgloop env
```

This shows every required variable, whether it's set, and where to get it if it's missing. Every missing variable includes a description and a direct link.

### Run diagnostics

```bash
orgloop doctor
```

Doctor checks deeper than `env` — it verifies that services are reachable, credentials are valid, and connectors can connect.

### Preview the plan

```bash
orgloop plan
```

```
OrgLoop Plan — my-org

  Sources:
    + github                  (new — poll every 5m)
    + linear                  (new — poll every 5m)
    + claude-code             (new — hook)

  Actors:
    + openclaw-engineering-agent  (new)

  Routes:
    + github-pr-review        (new)
    + github-ci-failure       (new)
    + linear-to-engineering   (new)
    + claude-code-to-supervisor  (new)

Plan: 8 to add, 0 to change, 0 to remove.
```

### Apply

```bash
orgloop start
```

Events are now flowing. Sources poll on their configured intervals, routes match incoming events, transforms filter noise, and actors receive focused work with situational launch prompts.

For production, run as a supervised daemon:

```bash
orgloop start --daemon --supervised
```

This runs in the background with automatic restart on crash.

### Check status

```bash
orgloop status
```

```
OrgLoop Runtime
  Status: running (PID 42831)
  Uptime: 2m 14s
  Control API: http://127.0.0.1:9801

  Sources: 3 | Actors: 1 | Routes: 4

  SOURCE           TYPE      HEALTH
  github           poll      healthy
  linear           poll      healthy
  claude-code      hook      —
```

Use `orgloop status` for a detailed view with per-source health.

---

## Next steps

- [User Guide](/start/user-guide/) -- day-to-day operations: logs, testing, customization
- [What is OrgLoop?](/start/what-is-orgloop/) -- deeper introduction to Organization as Code
- [Five Primitives](/concepts/five-primitives/) -- understand Sources, Actors, Routes, Transforms, Loggers
- [Projects](/concepts/projects/) -- project structure and configuration
- [Engineering Org example](/examples/engineering-org/) -- full production setup walkthrough
- [CLI Command Reference](/cli/command-reference/) -- all available commands
