---
title: "Example: Engineering Org"
description: Full engineering organization — GitHub, Linear, Claude Code routing to OpenClaw agents.
---

import { Aside } from '@astrojs/starlight/components';

<Aside type="caution" title="Prerequisites: 4 services">
This example requires accounts and tokens for **GitHub**, **Linear**, **Claude Code**, and **OpenClaw**. If you are new to OrgLoop, start with the [Minimal](/examples/minimal/) or [GitHub to Slack](/examples/github-to-slack/) examples first, then come back here.
</Aside>

A complete engineering organization: three sources (GitHub, Linear, Claude Code) route events through a filter and dedup pipeline to an [OpenClaw](https://openclaw.ai) agent. This replaces a collection of bespoke cron jobs and shell scripts with a single declarative config.

**What is OpenClaw?** OpenClaw is an AI agent orchestration platform that receives events via webhooks and dispatches work to AI agents (like Claude Code). It acts as the "actor" in this setup -- OrgLoop routes events to OpenClaw, and OpenClaw manages the agent sessions.

## Architecture

```
GitHub (poll 5m)  ──┐
Linear (poll 5m)  ──┼── transforms (bot filter, dedup) ──> OpenClaw agent
Claude Code (hook)──┘
```

Three sources emit events. Two transforms clean them. Five routes wire specific event types to the actor with appropriate SOPs (launch prompts).

## Prerequisites

- Node.js >= 22
- OrgLoop CLI installed (`npm install -g @orgloop/cli`)
- A [GitHub](https://github.com) account with a repository to monitor
- A [Linear](https://linear.app) account with an engineering team
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed locally
- An [OpenClaw](https://openclaw.ai) instance running (local or hosted)

## Environment variables

| Variable | Source | Description |
|----------|--------|-------------|
| `GITHUB_REPO` | GitHub | Repository in `owner/repo` format |
| `GITHUB_TOKEN` | [GitHub PAT](https://github.com/settings/tokens) | Personal access token with `repo` read access |
| `LINEAR_TEAM_KEY` | [Linear](https://linear.app) | Team key (e.g., `ENG`) -- find it in your team's settings |
| `LINEAR_API_KEY` | [Linear API Settings](https://linear.app/settings/api) | Personal API key |
| `OPENCLAW_WEBHOOK_TOKEN` | [OpenClaw](https://openclaw.ai) | Bearer token for OpenClaw API |
| `OPENCLAW_DEFAULT_TO` | [OpenClaw](https://openclaw.ai) | Default message recipient |

## Setup

```bash
# Scaffold the project
orgloop init    # select github, linear, openclaw, claude-code
cd my-org

# Install connector packages
npm install @orgloop/connector-github @orgloop/connector-linear \
  @orgloop/connector-claude-code @orgloop/connector-openclaw \
  @orgloop/transform-filter @orgloop/transform-dedup

# Install Claude Code hook (emits actor.stopped on session exit)
orgloop hook claude-code-stop

# Check environment variables
orgloop env

# Validate, preview, run
orgloop validate
orgloop plan
orgloop start
```

## Key config files

### `orgloop.yaml`

```yaml
# orgloop.yaml — Engineering org
# Full engineering organization event routing: GitHub, Linear, Claude Code -> OpenClaw

apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: engineering-org
  description: "Engineering organization event routing"

defaults:
  poll_interval: 5m
  event_retention: 7d
  log_level: info

connectors:
  - connectors/github.yaml
  - connectors/linear.yaml
  - connectors/claude-code.yaml
  - connectors/openclaw.yaml

transforms:
  - transforms/transforms.yaml

loggers:
  - loggers/default.yaml
```

### `connectors/github.yaml`

```yaml
# GitHub source — PR reviews, comments, CI failures

apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

sources:
  - id: github
    description: GitHub PR and CI activity
    connector: "@orgloop/connector-github"
    config:
      repo: "${GITHUB_REPO}"
      token: "${GITHUB_TOKEN}"
      events:
        - "pull_request.review_submitted"
        - "pull_request_review_comment"
        - "issue_comment"
        - "pull_request.closed"
        - "pull_request.merged"
        - "workflow_run.completed"
    poll:
      interval: 5m
    emits:
      - resource.changed
```

### `connectors/linear.yaml`

```yaml
# Linear source — ticket state changes and comments

apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

sources:
  - id: linear
    description: Linear ticket state changes and comments
    connector: "@orgloop/connector-linear"
    config:
      team: "${LINEAR_TEAM_KEY}"
      api_key: "${LINEAR_API_KEY}"
    poll:
      interval: 5m
    emits:
      - resource.changed
```

### `connectors/claude-code.yaml`

```yaml
# Claude Code source — session completion events via post-exit hook

apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

sources:
  - id: claude-code
    description: Claude Code session completion events
    connector: "@orgloop/connector-claude-code"
    config:
      hook_type: post-exit
    emits:
      - actor.stopped
```

### `connectors/openclaw.yaml`

```yaml
# OpenClaw actor — delivers events to an OpenClaw agent

apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

actors:
  - id: openclaw-engineering-agent
    description: Engineering OpenClaw agent
    connector: "@orgloop/connector-openclaw"
    config:
      base_url: "http://127.0.0.1:18789"
      auth_token_env: "${OPENCLAW_WEBHOOK_TOKEN}"
      agent_id: engineering
      default_channel: slack
      default_to: "${OPENCLAW_DEFAULT_TO}"
```

### `transforms/transforms.yaml`

```yaml
# Transforms — filter and deduplication pipeline

apiVersion: orgloop/v1alpha1
kind: TransformGroup

transforms:
  - name: drop-bot-noise
    type: package
    package: "@orgloop/transform-filter"
    config:
      exclude:
        provenance.author_type: bot

  - name: dedup
    type: package
    package: "@orgloop/transform-dedup"
    config:
      key:
        - source
        - type
        - provenance.platform_event
        - payload.pr_number
      window: 5m
      store: memory
```

### `routes/engineering.yaml`

```yaml
# Engineering event routing — the core org wiring

apiVersion: orgloop/v1alpha1
kind: RouteGroup
metadata:
  name: engineering-routes
  description: "Engineering event routing"

routes:
  - name: github-pr-review
    description: "PR review submitted -> Engineering agent"
    when:
      source: github
      events:
        - resource.changed
      filter:
        provenance.platform_event: pull_request.review_submitted
    transforms:
      - ref: drop-bot-noise
      - ref: dedup
    then:
      actor: openclaw-engineering-agent
      config:
        session_key: "hook:github:pr-review:engineering"
        wake_mode: now
        deliver: true
    with:
      prompt_file: "./sops/pr-review.md"

  - name: github-pr-comment
    description: "PR review comment -> Engineering agent"
    when:
      source: github
      events:
        - resource.changed
      filter:
        provenance.platform_event: pull_request_review_comment
    transforms:
      - ref: drop-bot-noise
      - ref: dedup
    then:
      actor: openclaw-engineering-agent
      config:
        session_key: "hook:github:pr-comment:engineering"
        wake_mode: now
        deliver: true
    with:
      prompt_file: "./sops/pr-review.md"

  - name: github-ci-failure
    description: "CI failure -> Engineering agent"
    when:
      source: github
      events:
        - resource.changed
      filter:
        provenance.platform_event: workflow_run.completed
    then:
      actor: openclaw-engineering-agent
      config:
        session_key: "hook:github:ci-failure:engineering"
        wake_mode: now
    with:
      prompt_file: "./sops/ci-failure.md"

  - name: claude-code-to-supervisor
    description: "Claude Code completion -> Supervisor"
    when:
      source: claude-code
      events:
        - actor.stopped
    then:
      actor: openclaw-engineering-agent
      config:
        session_key: "hook:claude-code:engineering"
        wake_mode: now

  - name: linear-to-engineering
    description: "Linear state change -> Engineering agent"
    when:
      source: linear
      events:
        - resource.changed
    transforms:
      - ref: dedup
    then:
      actor: openclaw-engineering-agent
      config:
        session_key: "hook:linear:activity:engineering"
        wake_mode: now
        deliver: true
    with:
      prompt_file: "./sops/linear-ticket.md"
```

## Routes

| Route | Trigger | Actor | SOP |
|-------|---------|-------|-----|
| `github-pr-review` | PR review submitted | openclaw-engineering-agent | `sops/pr-review.md` |
| `github-pr-comment` | PR review comment | openclaw-engineering-agent | `sops/pr-review.md` |
| `github-ci-failure` | CI workflow failed | openclaw-engineering-agent | `sops/ci-failure.md` |
| `claude-code-to-supervisor` | Claude Code session ended | openclaw-engineering-agent | -- |
| `linear-to-engineering` | Linear ticket changed | openclaw-engineering-agent | `sops/linear-ticket.md` |

## How events flow

1. **GitHub** polls every 5 minutes for new PR reviews, comments, and CI completions. Each becomes a `resource.changed` event.
2. **Linear** polls every 5 minutes for ticket state changes. Also emits `resource.changed`.
3. **Claude Code** emits `actor.stopped` when a session exits (via the post-exit hook).
4. The router matches each event against the five routes using `source` and `filter` criteria.
5. Matched events pass through the **transform pipeline** -- `drop-bot-noise` filters out bot-authored events, `dedup` drops duplicates within a 5-minute window.
6. Surviving events are delivered to the **OpenClaw engineering agent** with the appropriate SOP as a launch prompt.

## Customization

- **Add event types**: edit `connectors/github.yaml` under `config.events`
- **Filter by Linear state**: add a `filter` clause to the `linear-to-engineering` route
- **New SOPs**: create files in `sops/` and reference them from routes via `with.prompt_file`
- **Poll frequency**: adjust `poll.interval` per source in each connector file
- **Add an actor**: define a new actor in a connector file and add routes pointing to it
