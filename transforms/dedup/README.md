# @orgloop/transform-dedup

Deduplicate events within a configurable time window using SHA-256 hashing.

## Install

```bash
npm install @orgloop/transform-dedup
```

## Configuration

```yaml
transforms:
  - name: dedup-5m
    type: package
    package: "@orgloop/transform-dedup"
    config:
      key:
        - source
        - type
        - payload.pr_number
      window: "5m"
```

## Config options

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `key` | `string[]` | yes | -- | Dot-path fields used to build the dedup hash. |
| `window` | `string` | yes | `"5m"` | Duration window. Units: `ms`, `s`, `m`, `h`, `d`. |
| `store` | `string` | no | `"memory"` | Storage backend. Only `"memory"` currently. |

## Behavior

For each event, values at the configured `key` paths are extracted, concatenated (null-separated), and SHA-256 hashed. If the hash was seen within the `window` duration, the event is dropped. Otherwise it passes through and the hash is recorded.

A periodic cleanup timer (interval = max of window duration, 10s) evicts expired entries. State is in-memory only and lost on restart.

## Documentation

Full documentation at [orgloop.ai](https://orgloop.ai)

## License

MIT
