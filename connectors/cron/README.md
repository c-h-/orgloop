# @orgloop/connector-cron

Schedule-based source connector for OrgLoop. Emits events on time-based schedules using standard 5-field cron expressions or interval syntax. No environment variables required -- purely config-driven.

## Install

```bash
npm install @orgloop/connector-cron
```

## Configuration

```yaml
sources:
  - id: schedules
    connector: "@orgloop/connector-cron"
    config:
      schedules:
        - name: daily-standup
          cron: "0 9 * * 1-5"
          payload:
            task: "standup"

        - name: health-check
          cron: "every 5m"
          payload:
            task: "health_check"
    poll:
      interval: "1m"
```

### Config options

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schedules` | `array` | yes | One or more schedule definitions (at least one required) |
| `schedules[].name` | `string` | yes | Unique name for the schedule (used in event provenance as `schedule.<name>`) |
| `schedules[].cron` | `string` | yes | Cron expression or interval (see Syntax below) |
| `schedules[].payload` | `object` | no | Additional fields to include in emitted event payloads |

### Schedule syntax

**5-field cron expressions** (minute hour day-of-month month day-of-week):

```
0 9 * * 1-5        # 9:00 AM weekdays
*/15 * * * *        # Every 15 minutes
0 0 1 * *           # Midnight on the 1st of each month
30 8-17 * * 1-5     # Every hour at :30, 8am-5pm weekdays
0-30/10 * * * *     # Every 10 minutes in the first half-hour
```

Supports: `*`, specific values, ranges (`1-5`), steps (`*/N`, `1-5/2`), and comma-separated lists.

**Interval syntax**:

```
every 5m      # Every 5 minutes
every 1h      # Every hour
every 30s     # Every 30 seconds
5m            # Bare duration also works
```

## Events emitted

Events are emitted as OrgLoop `resource.changed` type.

| Provenance field | Value |
|------------------|-------|
| `platform` | `"cron"` |
| `platform_event` | `"schedule.<name>"` (e.g. `"schedule.daily-standup"`) |
| `author_type` | `"system"` |

### Example event payload

```json
{
  "id": "evt_a1b2c3d4e5f67890",
  "timestamp": "2025-01-15T09:00:00.000Z",
  "source": "schedules",
  "type": "resource.changed",
  "provenance": {
    "platform": "cron",
    "platform_event": "schedule.daily-standup",
    "author_type": "system"
  },
  "payload": {
    "schedule": "daily-standup",
    "task": "standup"
  }
}
```

For interval-based schedules, the payload also includes `interval_ms` (the interval in milliseconds).

## Example route

```yaml
routes:
  - name: standup-trigger
    when:
      source: schedules
      events:
        - resource.changed
      filter:
        payload.schedule: daily-standup
    then:
      actor: openclaw-agent
    with:
      prompt_file: sops/daily-standup.md
```

## Auth / prerequisites

None. This connector is purely config-driven and requires no API tokens or environment variables.

## Limitations / known issues

- **Poll-based matching** -- Cron matching is checked on each `poll()` call. If the poll interval is longer than the cron resolution, events may be coalesced (e.g., a per-minute cron with a 5-minute poll interval fires once, not five times).
- **Minute resolution** -- Cron expressions resolve to the minute. Sub-minute precision is only available via interval syntax.
- **No timezone support** -- Cron expressions are evaluated against the system's local time.
- **Checkpoint is JSON** -- The checkpoint stores last-trigger timestamps per schedule name, serialized as JSON. This is opaque to the engine.
