# Multi-Agent Supervisor Example

Demonstrates the feedback loop pattern: Claude Code sessions emit `actor.stopped` events, which route to a supervisor actor that reviews work and can re-dispatch tasks.

> **New to OrgLoop?** Start with the [Minimal](../minimal/) example first -- no accounts or tokens required.

## Prerequisites

- Node.js >= 22
- OrgLoop CLI installed (`npm install -g @orgloop/cli`)
- A [GitHub](https://github.com) account with a repository to monitor
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed locally
- An [OpenClaw](https://openclaw.ai) instance running locally

## What it does

- **Claude Code** connector receives session exit events via post-exit hook
- **GitHub** connector polls for PR activity (the work Claude Code produces)
- A **supervisor** actor (via [OpenClaw](https://openclaw.ai)) receives both streams and decides what to do next
- The supervisor's own sessions feed back as `actor.stopped` events, creating the recursive loop

This is OrgLoop's core insight in action: actors complete sessions, the system observes the completion, and routes it to the next actor in the chain.

## The feedback loop

```
Claude Code session ends
       |
       v
  actor.stopped
       |
       v
  Route: session-review
       |
       v
  Supervisor agent (reviews work, may dispatch follow-ups)
       |
       v
  Supervisor session ends -> actor.stopped -> ... (loop)
```

## Setup

### 1. Environment variables

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `GITHUB_REPO` | Repository being worked on (`owner/repo`) | Your GitHub repo URL |
| `GITHUB_TOKEN` | GitHub PAT with `repo` read access | [GitHub Settings > Tokens](https://github.com/settings/tokens) |
| `OPENCLAW_WEBHOOK_TOKEN` | Bearer token for OpenClaw API | Your [OpenClaw](https://openclaw.ai) instance |
| `OPENCLAW_DEFAULT_TO` | Default message recipient | Your OpenClaw team configuration |

### 2. Install Claude Code hook

```bash
orgloop hook claude-code-stop
```

### 3. Run

```bash
cd examples/multi-agent-supervisor
orgloop validate
orgloop start
```

## Files

```
orgloop.yaml              # All config in one file
sops/
  review-session.md       # Launch prompt for session review
  review-pr.md            # Launch prompt for PR review
```

## Routes

| Route | Trigger | Actor | Purpose |
|-------|---------|-------|---------|
| `session-review` | Claude Code `actor.stopped` | supervisor | Review completed session |
| `pr-review` | GitHub `resource.changed` (PR review) | supervisor | Handle PR feedback |

## Key concept

`actor.stopped` is deliberately neutral. OrgLoop observes that a session ended -- it does not claim the work succeeded or failed. The supervisor actor reads the session payload and decides:

- Was the work completed? Move on.
- Did the agent get stuck? Re-dispatch with more context.
- Did something break? Escalate.

The system routes signals. Actors have opinions.
