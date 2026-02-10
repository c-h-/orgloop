# @orgloop/transform-filter

Drop or keep events using dot-path pattern matching or jq expressions.

## Install

```bash
npm install @orgloop/transform-filter
```

## Configuration

### Match / Exclude mode

```yaml
transforms:
  - name: humans-only
    type: package
    package: "@orgloop/transform-filter"
    config:
      match:
        type: "resource.changed"
        "provenance.author_type": "team_member"
      exclude:
        "provenance.author":
          - "dependabot[bot]"
          - "renovate[bot]"
```

### jq mode

```yaml
transforms:
  - name: high-priority
    type: package
    package: "@orgloop/transform-filter"
    config:
      jq: '.payload.priority == "high"'
```

## Config options

| Field | Type | Description |
|-------|------|-------------|
| `match` | `object` | Dot-path field patterns. **All** must match to pass (AND). |
| `match_any` | `object` | Dot-path field patterns. **Any** match keeps the event (OR). |
| `exclude` | `object` | Dot-path field patterns. **Any** match drops the event. |
| `jq` | `string` | jq expression. Truthy = pass, falsy/error = drop. Takes precedence over match/exclude. |

## Behavior

**Match/exclude mode** evaluates in order: `exclude` first (any match drops), then `match` (all must match), then `match_any` (any must match). Fields use dot-notation for nested access (e.g., `provenance.author`). Values support exact strings, numbers, booleans, arrays (match any element), regex patterns (`/pattern/flags`), and comma-separated shorthand (`"alice,bob"`).

**jq mode** pipes the event through a `jq` subprocess (5s timeout). If jq returns a valid JSON object with an `id` field, the modified event replaces the original. Requires `jq` on `PATH`.

## Documentation

Full documentation at [orgloop.ai](https://orgloop.ai)

## License

MIT
