# @orgloop/logger-console

OrgLoop console logger -- colored, human-readable output for development and debugging. Writes to stderr so stdout stays clean for JSON output.

## Install

```bash
npm install @orgloop/logger-console
```

## Configuration

```yaml
loggers:
  - name: console
    type: "@orgloop/logger-console"
    config:
      level: info        # Minimum log level: debug | info | warn | error
      color: true        # Use ANSI colors in output
      compact: true      # One line per entry (false for verbose multi-line)
      show_payload: false # Show event payload metadata in verbose mode
```

All fields are optional and shown with their defaults.

## Behavior

Each log entry is formatted with a timestamp, phase icon, and contextual fields:

```
14:32:01.123 ● source.emit src=github type=resource.changed
14:32:01.456 ► route.match route=pr-review tgt=agent
14:32:02.789 ✓ deliver.success tgt=agent 342ms
```

Phase icons and colors are mapped by event lifecycle phase:

| Phase | Icon | Color |
|-------|------|-------|
| `source.emit` | ● | blue |
| `route.match` | ► | cyan |
| `deliver.success` | ✓ | green |
| `deliver.failure` | ✗ | red |
| `transform.error` | ⚠ | yellow |
| `system.start` / `system.stop` | ● | magenta |

Level filtering maps each phase to a severity (debug/info/warn/error). Setting `level: warn` suppresses info-level phases like `route.match` and `deliver.success`.

Set `compact: false` and `show_payload: true` for verbose multi-line output with metadata.

## Documentation

Full documentation at [orgloop.ai](https://orgloop.ai)

## License

MIT
