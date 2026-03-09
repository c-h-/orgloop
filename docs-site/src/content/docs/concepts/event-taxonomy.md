---
title: Event Taxonomy
description: The three event types that drive OrgLoop's routing system.
---

OrgLoop uses three event types. This taxonomy is minimal by design -- new types are always additive, never replacing existing ones.

## Event Types

| Type | Meaning | Example |
|------|---------|---------|
| `resource.changed` | Something changed in an external system | PR opened, ticket moved, CI failed, deploy completed |
| `actor.stopped` | An actor's session ended | Claude Code exited, Codex finished, OpenClaw agent completed |
| `message.received` | A human or system sent a message | Slack message, webhook payload, CLI notification |

Routes match on these types using the `events` field:

```yaml
routes:
  - name: pr-review
    when:
      source: github
      events: [resource.changed]
    then:
      actor: engineering
```

## Event Envelope

Every event shares the same envelope structure. The envelope is generic; payloads are connector-specific.

```json
{
  "id": "evt_a1b2c3d4e5",
  "timestamp": "2026-02-08T20:47:00Z",
  "source": "github",
  "type": "resource.changed",
  "provenance": {
    "platform": "github",
    "platform_event": "pull_request.review_submitted",
    "author": "alice",
    "author_type": "team_member"
  },
  "payload": {
    "pull_request": {
      "number": 42,
      "title": "Refactor auth module",
      "url": "https://github.com/my-org/my-repo/pull/42"
    }
  },
  "trace_id": "trc_x9y8z7w6"
}
```

### Envelope Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique event identifier. Always prefixed with `evt_`. |
| `timestamp` | `string` | ISO 8601 UTC timestamp. |
| `source` | `string` | Source connector ID that emitted this event. |
| `type` | `string` | One of the three event types. |
| `provenance` | `object` | Origin metadata -- platform, original event type, author, author classification. |
| `payload` | `object` | Connector-specific data (freeform JSON). |
| `trace_id` | `string` | Trace ID for end-to-end pipeline tracing. Prefixed with `trc_`. Added by the engine. |

### Provenance

Provenance carries metadata about where the event originated in the external system:

| Field | Description |
|-------|-------------|
| `platform` | The external platform (`github`, `linear`, `claude-code`, etc.) |
| `platform_event` | The original event type on that platform (`pull_request.review_submitted`, `issue.state_change`) |
| `author` | Who caused the event (`alice`, `app/renovate-bot`) |
| `author_type` | Classification: `team_member`, `external`, `bot`, `system`, `unknown` |

Routes can filter on provenance fields using dot-path matching:

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
```

## actor.stopped is Neutral

`actor.stopped` is deliberately neutral. OrgLoop observes that a session ended. Whether the work was completed, the agent crashed, got stuck, or lied about finishing -- that is for the receiving actor to judge. OrgLoop routes signals; actors have opinions.

This design enables supervision patterns:

```
Claude Code session ends
       |
       v
  actor.stopped event (payload contains session details)
       |
       v
  Route matches --> Supervisor actor wakes
       |
       v
  Supervisor reads payload, decides:
    - Work completed? Move on.
    - Agent stuck? Re-dispatch with more context.
    - Something broke? Escalate.
```

The supervisor makes the judgment call, not OrgLoop. The routing layer is opinion-free.

## Payloads are Connector-Specific

The event envelope is generic, but payloads are connector-specific. A GitHub `resource.changed` event carries PR data. A Linear `resource.changed` event carries ticket data. Connectors do not assume payload shapes from other connectors.

This keeps the system composable. You can swap connectors without changing route logic, because routes match on envelope fields (`source`, `type`, `provenance`), not payload internals.

## Tracing

Every event receives a `trace_id` (prefixed with `trc_`) when it enters the engine. The trace ID is carried through every phase of the pipeline -- source ingestion, transform execution, route matching, actor delivery, and logging. Use it to trace a single event end-to-end:

```bash
orgloop logs --event evt_a1b2c3d4e5
```

### Lifecycle Events

Coding harness connectors (Claude Code, Codex, OpenCode, Pi, Pi-rust) emit `actor.stopped` events with a **normalized lifecycle payload**. This payload includes `payload.lifecycle` (phase, terminal, outcome, dedupe_key) and `payload.session` (id, harness, exit_status), enabling harness-agnostic routing and supervision. Non-terminal phases (`started`, `active`) emit `resource.changed` instead.

See the [Lifecycle Contract](/spec/lifecycle-contract/) for the full specification.

See the [Event Schema](/reference/event-schema/) for the full JSON Schema definition, or the [Five Primitives](/concepts/five-primitives/) for how events flow through the system.
