# @orgloop/transform-enrich

Add, copy, and compute fields on events before delivery.

## Install

```bash
npm install @orgloop/transform-enrich
```

## Configuration

```yaml
transforms:
  - name: add-metadata
    type: package
    package: "@orgloop/transform-enrich"
    config:
      set:
        payload.team: platform
        payload.environment: production
      copy:
        payload.author: provenance.author
      compute:
        payload.is_critical: "payload.priority === 'P0'"
        payload.large_diff: "payload.lines_changed > 500"
```

## Config options

| Field | Type | Description |
|-------|------|-------------|
| `set` | `object` | Static values to add. Keys are target dot-paths, values are literals. |
| `copy` | `object` | Copy fields. Keys are target dot-paths, values are source dot-paths. |
| `compute` | `object` | Computed fields. Keys are target dot-paths, values are comparison expressions. |

## Behavior

Operations apply in order on a shallow clone of the event:

1. **set** -- Assigns static values at dot-paths. Intermediate objects are created as needed.
2. **copy** -- Reads from source path, writes to target path. Skipped if source is undefined.
3. **compute** -- Evaluates simple comparison expressions (no `eval()`). Supported operators: `===`, `!==`, `>`, `<`, `>=`, `<=`. Values can be quoted strings (`'value'`), numbers, or unquoted identifiers.

All field paths use dot notation for nested access (e.g., `payload.review.state`).

## Documentation

Full documentation at [orgloop.ai](https://orgloop.ai)

## License

MIT
