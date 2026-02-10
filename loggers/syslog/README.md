# @orgloop/logger-syslog

OrgLoop syslog logger -- RFC 5424 formatted messages for enterprise and Unix deployments. Supports UDP, TCP, and Unix socket transports with zero external dependencies.

## Install

```bash
npm install @orgloop/logger-syslog
```

## Configuration

```yaml
loggers:
  - name: syslog
    type: "@orgloop/logger-syslog"
    config:
      transport: udp       # udp | tcp | unix
      host: "127.0.0.1"   # Syslog server host (udp/tcp)
      port: 514            # Syslog server port (udp/tcp)
      path: "/dev/log"     # Unix socket path (unix transport)
      facility: local0     # Syslog facility
      app_name: orgloop    # APP-NAME field in messages
      include_structured_data: true  # Include [orgloop@49999 ...] SD element
```

All fields are optional and shown with their defaults.

## Behavior

Each log entry is formatted as an RFC 5424 syslog message:

```
<134>1 2025-01-15T14:32:02.789Z myhost orgloop 12345 deliver.success [orgloop@49999 event_id="evt_abc" source="github" target="agent" duration_ms="342"] deliver.success github resource.changed evt_abc
```

**Severity mapping:** OrgLoop log phases are mapped to RFC 5424 severity levels:

| Severity | Phases |
|----------|--------|
| Error (3) | `deliver.failure`, `system.error` |
| Warning (4) | `transform.error`, `deliver.retry` |
| Informational (6) | `deliver.success`, `route.match`, `system.start`, `system.stop` |
| Debug (7) | `source.emit`, `route.no_match`, `transform.start` |

A `system.error` with `metadata.fatal: true` is upgraded to Critical (2).

**Structured data:** When enabled, event metadata is included as an RFC 5424 structured data element using `orgloop@49999` as the SD-ID, with fields like `event_id`, `trace_id`, `source`, `target`, and `duration_ms`.

**Transports:**

- **UDP** (default): Fire-and-forget. Lowest latency, no connection management.
- **TCP**: Reliable delivery with newline-delimited framing (RFC 5425). Auto-reconnects on failure with buffering during reconnection (up to 1000 messages).
- **Unix**: Same as TCP but over a Unix domain socket (e.g., `/dev/log`).

## Documentation

Full documentation at [orgloop.ai](https://orgloop.ai)

## License

MIT
