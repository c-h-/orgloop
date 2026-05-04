# @orgloop/connector-coding-agent

Harness-agnostic connector for capturing coding agent session lifecycle events via webhook. Works with any coding agent harness (Claude Code, Codex, OpenCode, Pi, Pi-rust, etc.) that sends lifecycle events via HTTP POST.

## Install

```bash
npm install @orgloop/connector-coding-agent
```

## Configuration

```yaml
sources:
  # Explicit platform
  - id: opencode
    connector: "@orgloop/connector-coding-agent"
    config:
      platform: opencode
      secret: "${OPENCODE_WEBHOOK_SECRET}"  # optional

  # Platform defaults to source id
  - id: claude-code
    connector: "@orgloop/connector-coding-agent"
    config:
      secret: "${CLAUDE_CODE_WEBHOOK_SECRET}"  # optional
```

### Config options

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `platform` | `string` | no | Platform identifier for provenance metadata. Defaults to the source ID |
| `harness` | `string` | no | Harness identifier for `session.harness`. Defaults to `platform` value |
| `secret` | `string` | no | HMAC-SHA256 secret for validating incoming webhook signatures. Supports `${ENV_VAR}` syntax |
| `buffer_dir` | `string` | no | Directory for buffering received events to disk (JSONL). If set, events survive engine restarts |

## Events emitted

Events follow the normalized lifecycle contract in `event.payload.lifecycle` and `event.payload.session`.

Non-terminal phases emit `resource.changed`. Terminal phases emit `actor.stopped`.

### Event kind

| Platform event | Trigger | Description |
|---|---|---|
| `session.started` | Coding agent session starts | Session launched (start hook) |
| `session.completed` | Session ends with exit 0 | Session completed successfully |
| `session.failed` | Session ends with non-zero exit | Session failed |
| `session.stopped` | Session ends via signal | Session stopped/cancelled |

### Example event payload

```json
{
  "id": "evt_a1b2c3d4e5f67890",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "source": "opencode",
  "type": "actor.stopped",
  "provenance": {
    "platform": "opencode",
    "platform_event": "session.completed",
    "author": "opencode",
    "author_type": "bot",
    "session_id": "sess-abc123",
    "working_directory": "/home/user/my-project"
  },
  "payload": {
    "lifecycle": {
      "phase": "completed",
      "terminal": true,
      "outcome": "success",
      "reason": "exit_code_0",
      "dedupe_key": "opencode:sess-abc123:completed"
    },
    "session": {
      "id": "sess-abc123",
      "adapter": "opencode",
      "harness": "opencode",
      "cwd": "/home/user/my-project",
      "ended_at": "2025-01-15T10:30:00.000Z",
      "exit_status": 0
    },
    "session_id": "sess-abc123",
    "working_directory": "/home/user/my-project",
    "duration_seconds": 120,
    "exit_status": 0,
    "summary": "Implemented auth module and added tests"
  }
}
```

### Webhook request format

POST a JSON body to the connector's webhook endpoint:

```json
{
  "session_id": "sess-abc123",
  "working_directory": "/home/user/my-project",
  "duration_seconds": 120,
  "exit_status": 0,
  "summary": "Implemented auth module and added tests"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | `string` | yes | Session identifier |
| `working_directory` | `string` | no | Working directory of the session |
| `cwd` | `string` | no | Alias for `working_directory` |
| `duration_seconds` | `number` | no | Session duration in seconds |
| `exit_status` | `number` | no | Process exit code (0 = success) |
| `summary` | `string` | no | Optional session summary text |
| `hook_type` | `string` | no | `start` or `stop` (defaults to `stop`) |
| `timestamp` | `string` | no | Optional ISO 8601 timestamp |

## Migrating from the per-harness packages

The previous `@orgloop/connector-{claude-code,codex,opencode,pi,pi-rust}` packages
have been removed. Replace them with `@orgloop/connector-coding-agent` and select
the harness profile via the `harness` config field:

```yaml
sources:
  - id: claude-code
    connector: "@orgloop/connector-coding-agent"
    config:
      harness: claude-code
```

Existing configs that set `platform` (without `harness`) keep working: when
`platform` matches a known harness name (`claude-code`, `codex`, `opencode`, `pi`,
`pi-rust`) the connector selects that harness profile and the explicit `platform`
value is preserved in event provenance and dedupe keys.

## Example route

```yaml
routes:
  - name: agent-exit-review
    when:
      source: opencode
      events:
        - actor.stopped
    then:
      actor: openclaw-agent
```
