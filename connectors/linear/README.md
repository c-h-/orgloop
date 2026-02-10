# @orgloop/connector-linear

Polls the Linear GraphQL API for issue and comment activity on a team, with optional project scoping.

## Install

```bash
npm install @orgloop/connector-linear
```

## Configuration

```yaml
sources:
  - id: linear-eng
    connector: "@orgloop/connector-linear"
    config:
      team: "ENG"                      # Linear team key
      project: "Backend Rewrite"       # optional — scope to a specific project name
      api_key: "${LINEAR_API_KEY}"     # Linear API key (env var ref)
    poll:
      interval: "5m"
```

### Config options

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `team` | `string` | yes | Linear team key (e.g., `ENG`, `FRONT`) |
| `project` | `string` | no | Filter to issues belonging to this project name |
| `api_key` | `string` | yes | Linear API key. Supports `${ENV_VAR}` syntax |
| `cache_dir` | `string` | no | Directory for persisting issue state cache (default: system tmpdir) |

## Events emitted

All events are emitted as OrgLoop `resource.changed` type.

### Event kinds

| Platform event | Trigger | Description |
|---|---|---|
| `issue.created` | New issue created since last poll | A new issue was added to the team |
| `issue.state_changed` | Issue state transition detected | Issue moved between states (e.g., "Todo" to "In Progress") |
| `issue.assignee_changed` | Assignee change detected | Issue was assigned or reassigned |
| `issue.priority_changed` | Priority change detected | Issue priority level changed |
| `issue.labels_changed` | Label change detected | Labels were added or removed from an issue |
| `comment.created` | New comment since last poll | A comment was posted on an issue |

### Example event payload (issue state change)

```json
{
  "id": "evt_a1b2c3d4e5f67890",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "source": "linear:ENG",
  "type": "resource.changed",
  "provenance": {
    "platform": "linear",
    "platform_event": "issue.state_changed",
    "author": "Alice Smith",
    "author_type": "team_member",
    "issue_id": "ENG-42",
    "state": "In Progress",
    "url": "https://linear.app/my-org/issue/ENG-42"
  },
  "payload": {
    "action": "state_changed",
    "issue_id": "ENG-42",
    "issue_title": "Implement new auth flow",
    "previous_state": "Todo",
    "new_state": "In Progress"
  }
}
```

### Example event payload (new comment)

```json
{
  "id": "evt_b2c3d4e5f6789012",
  "timestamp": "2025-01-15T11:00:00.000Z",
  "source": "linear:ENG",
  "type": "resource.changed",
  "provenance": {
    "platform": "linear",
    "platform_event": "comment.created",
    "author": "Bob Jones",
    "author_type": "team_member",
    "issue_id": "ENG-42",
    "url": "https://linear.app/my-org/issue/ENG-42#comment-abc"
  },
  "payload": {
    "action": "comment_created",
    "issue_id": "ENG-42",
    "issue_title": "Implement new auth flow",
    "comment_body": "Looks good, let's move forward."
  }
}
```

## Example route

```yaml
routes:
  - name: linear-state-change-notify
    when:
      source: linear-eng
      events:
        - resource.changed
      filter:
        provenance.platform_event: issue.state_changed
    then:
      actor: openclaw-agent
```

## Auth / prerequisites

- A **Linear API key** with read access. Create one at Linear Settings > API > Personal API keys.
- Set the key as an environment variable (e.g., `LINEAR_API_KEY`) and reference it in config with `${LINEAR_API_KEY}`.

## Limitations / known issues

- **Polling only** -- this connector queries the Linear GraphQL API on a schedule. Events may be delayed up to one poll interval.
- **State change detection** -- The connector maintains an in-memory cache of issue states. On first start (cold cache), it only emits `issue.created` events for recently created issues; state changes are only detected from the second poll onward.
- **Cache persisted to disk** -- The issue state cache is saved to disk (in `cache_dir`) after every poll. On restart, the cache is reloaded so state transitions during downtime are not missed.
- **Rate limits** -- Linear API rate limits apply. The connector backs off gracefully on 429 / `RATE_LIMITED` responses.
- **Fetches up to 50 items** -- Each poll retrieves a maximum of 50 updated issues and 50 new comments.
- **Author names** -- Linear events use display names (not usernames) as the `author` field.
