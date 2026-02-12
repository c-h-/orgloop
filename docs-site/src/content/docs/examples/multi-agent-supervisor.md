---
title: "Example: Multi-Agent Supervisor"
description: Feedback loop pattern — actor completion events route back to a supervisor agent.
---

import { Aside } from '@astrojs/starlight/components';

<Aside type="caution" title="Prerequisites: 3 services">
This example requires **GitHub**, **Claude Code**, and **OpenClaw**. If you are new to OrgLoop, start with the [Minimal](/examples/minimal/) example first (no accounts needed), then come back here.
</Aside>

The feedback loop pattern -- the defining feature of OrgLoop. Claude Code sessions emit `actor.stopped` events, which route to a supervisor actor that reviews work and can re-dispatch tasks. The supervisor's own completions feed back into the system, creating a recursive loop.

## What this example shows

- `actor.stopped` events as first-class routing signals
- The recursive loop: actor completes -> event emitted -> routed to supervisor -> supervisor completes -> event emitted -> ...
- SOPs (Standard Operating Procedures) as launch prompts that guide actor behavior
- Why `actor.stopped` is deliberately neutral -- the system observes, actors judge

## The pattern

```
Claude Code session ends
       |
       v
  actor.stopped event
       |
       v
  Route: session-review
       |
       v
  Supervisor agent (reads payload, evaluates work)
       |
       +-- Work complete? Move on.
       +-- Work partial? Re-dispatch with instructions.
       +-- Session crashed? Investigate and retry.
       |
       v
  Supervisor session ends -> actor.stopped -> ... (loop continues)
```

The loop sustains itself. Every actor completion is an event. Every event can be routed. The supervisor is just another actor whose completions feed back through the same system.

## Prerequisites

- Node.js >= 22
- OrgLoop CLI installed (`npm install -g @orgloop/cli`)
- A [GitHub](https://github.com) account with a repository to monitor
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed locally (for the post-exit hook)
- An [OpenClaw](https://openclaw.ai) instance running locally -- OpenClaw is an AI agent orchestration platform that manages agent sessions

## Setup

### 1. Environment variables

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `GITHUB_REPO` | Repository being worked on (`owner/repo`) | Your GitHub repo URL |
| `GITHUB_TOKEN` | GitHub PAT with `repo` read access | [GitHub Settings > Tokens](https://github.com/settings/tokens) |
| `OPENCLAW_WEBHOOK_TOKEN` | Bearer token for OpenClaw API | Your [OpenClaw](https://openclaw.ai) instance |
| `OPENCLAW_DEFAULT_TO` | Default message recipient | Your OpenClaw team configuration |

### 2. Install the Claude Code hook

```bash
orgloop hook claude-code-stop
```

This registers a post-exit hook so Claude Code emits `actor.stopped` events when sessions end.

### 3. Run

```bash
cd examples/multi-agent-supervisor
orgloop validate
orgloop start
```

## The config

### `orgloop.yaml`

```yaml
# orgloop.yaml — Multi-Agent Supervisor
# Claude Code sessions feed back through a supervisor actor, creating a recursive loop.

apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: multi-agent-supervisor
  description: "Claude Code supervision with feedback loop"

defaults:
  poll_interval: 5m
  log_level: info

# ─── Sources ─────────────────────────────────────────────────────────────────

sources:
  - id: claude-code
    description: Claude Code session completion events
    connector: "@orgloop/connector-claude-code"
    config:
      hook_type: post-exit
    emits:
      - actor.stopped

  - id: github
    description: GitHub PR activity (work produced by Claude Code)
    connector: "@orgloop/connector-github"
    config:
      repo: "${GITHUB_REPO}"
      token: "${GITHUB_TOKEN}"
      events:
        - "pull_request.review_submitted"
        - "pull_request_review_comment"
    poll:
      interval: 5m
    emits:
      - resource.changed

# ─── Actor ───────────────────────────────────────────────────────────────────

actors:
  - id: supervisor
    description: Supervisor agent — reviews work, re-dispatches if needed
    connector: "@orgloop/connector-openclaw"
    config:
      base_url: "http://127.0.0.1:18789"
      auth_token_env: "${OPENCLAW_WEBHOOK_TOKEN}"
      agent_id: supervisor
      default_channel: slack
      default_to: "${OPENCLAW_DEFAULT_TO}"

# ─── Routes ──────────────────────────────────────────────────────────────────

routes:
  - name: session-review
    description: "Claude Code session ended -> Supervisor reviews the work"
    when:
      source: claude-code
      events:
        - actor.stopped
    then:
      actor: supervisor
      config:
        session_key: "orgloop:claude-code:session-review"
        wake_mode: now
    with:
      prompt_file: "./sops/review-session.md"

  - name: pr-review
    description: "PR review received -> Supervisor handles feedback"
    when:
      source: github
      events:
        - resource.changed
      filter:
        provenance.platform_event: pull_request.review_submitted
    then:
      actor: supervisor
      config:
        session_key: "orgloop:github:pr-review"
        wake_mode: now
        deliver: true
    with:
      prompt_file: "./sops/review-pr.md"

# ─── Loggers ─────────────────────────────────────────────────────────────────

loggers:
  - name: console-log
    type: "@orgloop/logger-console"
    config:
      level: info
      color: true

  - name: file-log
    type: "@orgloop/logger-file"
    config:
      path: ~/.orgloop/logs/supervisor.log
      format: jsonl
      rotation:
        max_size: 50MB
        max_age: 7d
```

## Routes

| Route | Trigger | Actor | SOP |
|-------|---------|-------|-----|
| `session-review` | Claude Code `actor.stopped` | supervisor | `sops/review-session.md` |
| `pr-review` | GitHub `resource.changed` (PR review submitted) | supervisor | `sops/review-pr.md` |

## The SOP: `sops/review-session.md`

SOPs are launch prompts delivered to the actor alongside the event. They tell the actor what to do with the signal it received.

```markdown
# Review Claude Code Session

A Claude Code session has completed. Review what happened and decide next steps.

## Instructions

1. Read the session payload — check `exit_status`, `duration_seconds`, and `summary`
2. If a summary is provided, evaluate whether the described work sounds complete
3. Check the working directory for any uncommitted changes or failing tests
4. **Work looks complete** -> verify the PR is ready for review, move the ticket forward
5. **Work is partial** -> identify what remains and re-dispatch with specific instructions
6. **Session crashed (non-zero exit)** -> investigate the failure, retry with a simpler approach
7. **Session was very short (<30s)** -> likely hit an error early; check logs and retry with fixes

## Guidelines

- Don't trust the summary blindly — verify against actual repo state
- If re-dispatching, be specific about what needs to happen next
- Escalate to a human if the same task has failed multiple times
- Keep a running count of retries; stop after 3 attempts on the same task
```

The supervisor reads the `actor.stopped` payload (exit status, duration, summary) and cross-references it with actual repo state. It does not trust the completing actor's self-report.

## Why `actor.stopped` is neutral

OrgLoop does not interpret session outcomes. It observes that a session ended and routes that fact. The `actor.stopped` event payload carries details -- exit code, duration, summary -- but OrgLoop does not assign meaning to them.

This is deliberate. Whether work was completed, the agent crashed, got stuck, or fabricated its summary -- that is for the receiving actor (the supervisor) to judge. OrgLoop routes signals. Actors have opinions.

## How the loop sustains itself

1. Claude Code finishes a coding session. The post-exit hook fires.
2. The Claude Code connector emits an `actor.stopped` event.
3. The `session-review` route matches and delivers the event to the supervisor.
4. The supervisor reviews the work using the SOP as guidance.
5. The supervisor's own session eventually ends -- emitting another `actor.stopped` event.
6. If a route matches supervisor completions, the loop continues. If not, the chain terminates naturally.

The loop is not infinite by design. It terminates when no route matches the latest `actor.stopped` event, or when the SOP instructs the supervisor to stop retrying.

## When to use this pattern

- **Code review automation**: Claude Code writes code, supervisor validates it
- **Multi-step workflows**: break complex tasks into sessions, with a supervisor coordinating handoffs
- **Quality gates**: every AI-produced artifact passes through a review step before merging
- **Retry with escalation**: failed sessions get re-dispatched with more context, up to a retry limit
