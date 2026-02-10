# @orgloop/logger-file

OrgLoop file logger -- buffered JSONL output with automatic rotation, compression, and cleanup. The default production logger.

## Install

```bash
npm install @orgloop/logger-file
```

## Configuration

```yaml
loggers:
  - name: file
    type: "@orgloop/logger-file"
    config:
      path: "~/.orgloop/logs/orgloop.log"  # Log file path
      format: jsonl                         # Output format (jsonl only)
      rotation:
        max_size: "100MB"    # Rotate when file exceeds this size
        max_age: "7d"        # Delete rotated files after this duration
        max_files: 10        # Keep at most N rotated files
        compress: true       # Gzip rotated files
      buffer:
        size: 100            # Buffer N entries before flushing
        flush_interval: "1s" # Flush at least this often
```

All fields are optional and shown with their defaults.

## Behavior

Log entries are written as newline-delimited JSON (JSONL). Each line is a complete `LogEntry` object:

```json
{"phase":"deliver.success","event_id":"evt_abc123","trace_id":"trc_xyz","source":"github","target":"agent","timestamp":"2025-01-15T14:32:02.789Z","duration_ms":342}
```

**Buffering:** Entries are buffered in memory and flushed when the buffer reaches `size` entries or every `flush_interval`, whichever comes first. The log file is created on init so `tail -f` works immediately.

**Rotation:** When the file exceeds `max_size`, it is renamed with a timestamp suffix (e.g., `orgloop.log.2025-01-15T14-32-02-789Z`) and optionally gzip-compressed. Old rotated files are cleaned up based on `max_files` and `max_age`.

**Path resolution:** Supports `~` expansion to the home directory. Relative paths resolve relative to the YAML config file.

## Documentation

Full documentation at [orgloop.ai](https://orgloop.ai)

## License

MIT
