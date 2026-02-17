---
title: Five Primitives
description: Sources, Actors, Routes, Transforms, and Loggers — the building blocks of an OrgLoop system.
---

Five primitives describe your entire organization's event topology. Define them in YAML, and OrgLoop handles the rest.

| Primitive | Role |
|-----------|------|
| **Sources** | Emit events from external systems |
| **Actors** | Do work when woken by events |
| **Routes** | Wire sources to actors with filters and context |
| **Transforms** | Filter, enrich, or drop events in the pipeline |
| **Loggers** | Observe every event, transform, and delivery |

## Sources

Things that emit events. A GitHub repo, a Linear project, a Claude Code session, a cron schedule, a webhook endpoint -- anything that changes state.

Sources use **outbound polling** by default. OrgLoop reaches out to external systems on a schedule. This means zero inbound attack surface, no webhook secrets to manage, and it works behind NAT and firewalls. Hook-based sources (like Claude Code) receive events via a local HTTP endpoint.

```yaml
sources:
  - id: github
    connector: "@orgloop/connector-github"
    config:
      repo: "${GITHUB_REPO}"
      token: "${GITHUB_TOKEN}"
      poll:
        interval: 5m

  - id: linear
    connector: "@orgloop/connector-linear"
    config:
      team: "${LINEAR_TEAM_KEY}"
      api_key: "${LINEAR_API_KEY}"
      poll:
        interval: 5m

  - id: claude-code
    connector: "@orgloop/connector-claude-code"
    config:
      hook_type: post-exit
```

Secrets never live in YAML. Use `${VAR_NAME}` for environment variable substitution.

## Actors

Things that do work when woken. An OpenClaw agent, a webhook endpoint, a Slack channel -- any system that can receive an event and act on it.

Actors receive events with optional **launch prompts** -- focused, situational SOPs that tell the actor exactly how to approach a specific event type. Same actor, different prompts per route. The routing layer decides which SOP is relevant. The actor does not have to figure it out.

```yaml
actors:
  - id: engineering
    connector: "@orgloop/connector-openclaw"
    config:
      agent_id: engineering
      auth_token_env: "${OPENCLAW_WEBHOOK_TOKEN}"
```

## Routes

Declarative wiring. When source X emits event Y, wake actor Z with context C. Pure routing logic, no business logic.

Routes support **multi-route matching** -- a single event can match multiple routes and wake multiple actors. Routes are **allow-lists**: actors only see events their routes explicitly match. There is no broadcast bus.

```yaml
routes:
  - name: pr-review
    when:
      source: github
      events: [resource.changed]
      filter:
        provenance.platform_event:
          - pull_request.review_submitted
          - pull_request_review_comment
    transforms:
      - ref: drop-bot-noise
      - ref: dedup
    then:
      actor: engineering
    with:
      prompt_file: "./sops/pr-review.md"

  - name: ci-failure
    when:
      source: github
      events: [resource.changed]
      filter:
        provenance.platform_event: workflow_run.completed
    then:
      actor: engineering
    with:
      prompt_file: "./sops/ci-failure.md"
```

The `with.prompt_file` field points to a launch prompt -- a Markdown file with a focused SOP for this specific event type.

## Transforms

Optional pipeline steps between source and actor. Filter noise, deduplicate, enrich with metadata. Transforms are mechanical -- actors handle reasoning, transforms handle plumbing.

Two implementation types:
- **Package transforms** -- TypeScript implementations of the `Transform` interface (e.g., `@orgloop/transform-filter`)
- **Script transforms** -- shell scripts that read JSON from stdin, write modified JSON to stdout (exit code 0 = pass, exit code 78 = drop)

```yaml
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
      window: 1h
```

Transforms run **sequentially** -- order matters. A transform can pass the event through (optionally modified), or drop it entirely. The pipeline is fail-open by default: if a transform errors, the event passes through.

## Loggers

Passive observers. Every event, every transform result, every delivery is captured for debugging and audit. Loggers are **first-class primitives**, not optional add-ons.

```yaml
loggers:
  - name: file-log
    type: "@orgloop/logger-file"
    config:
      path: ~/.orgloop/logs/orgloop.log
      format: jsonl
      rotation:
        max_size: 100MB

  - name: console-log
    type: "@orgloop/logger-console"
    config:
      level: info
```

Four built-in loggers:
- **Console** -- ANSI colors, phase icons, level filtering
- **File** -- buffered JSONL, rotation by size/age/count, optional gzip compression
- **OpenTelemetry** -- OTLP export for observability platforms
- **Syslog** -- RFC 5424 syslog protocol

## The Loop

The defining feature: **the org loops**. When an actor finishes work, that completion is itself an event (`actor.stopped`), routed back into the system to trigger the next actor.

```
Source.poll() --> EventBus --> matchRoutes() --> Transforms --> Actor.deliver()
                    ^                                              |
                    +------------ actor.stopped -------------------+
```

A Claude Code session finishes at 3am. That fires `actor.stopped`. A route matches it and wakes a supervisor agent. The supervisor evaluates the output, decides to relaunch for QA. That completion fires another `actor.stopped`. The organization sustains itself through continuous cycles of events triggering actors triggering events.

## Complete Example

All five primitives in one config:

```yaml
# orgloop.yaml
sources:
  - id: github
    connector: "@orgloop/connector-github"
    config:
      repo: "${GITHUB_REPO}"
      token: "${GITHUB_TOKEN}"
      poll:
        interval: 5m

  - id: claude-code
    connector: "@orgloop/connector-claude-code"
    config:
      hook_type: post-exit

actors:
  - id: engineering
    connector: "@orgloop/connector-openclaw"
    config:
      agent_id: engineering
      auth_token_env: "${OPENCLAW_WEBHOOK_TOKEN}"

routes:
  - name: pr-review
    when:
      source: github
      events: [resource.changed]
    transforms:
      - ref: drop-bot-noise
    then:
      actor: engineering
    with:
      prompt_file: "./sops/pr-review.md"

  - name: session-supervision
    when:
      source: claude-code
      events: [actor.stopped]
    then:
      actor: engineering
    with:
      prompt_file: "./sops/evaluate-session.md"

transforms:
  - name: drop-bot-noise
    type: package
    package: "@orgloop/transform-filter"
    config:
      exclude:
        provenance.author_type: bot

loggers:
  - name: file-log
    type: "@orgloop/logger-file"
    config:
      path: ~/.orgloop/logs/orgloop.log
      format: jsonl
```

See the [Event Taxonomy](/concepts/event-taxonomy/) for details on the three event types, or the [Command Reference](/cli/command-reference/) for how to validate, plan, and start this config.
