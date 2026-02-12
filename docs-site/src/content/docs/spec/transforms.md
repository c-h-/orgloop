---
title: "Built-in Transforms"
description: "Transform interface, script contract, and built-in transforms — filter, dedup, injection scanner, and more."
---

### 10.1 Transform Interface: Dual-Mode

OrgLoop supports two transform modes:

1. **Script transforms** — shell scripts following the stdin/stdout contract from DESIGN.md. This is the primary mode. It's simple, language-agnostic, and debuggable.

2. **Package transforms** — TypeScript classes implementing the `Transform` interface from `@orgloop/sdk`. For performance-sensitive or complex transforms that benefit from in-process execution.

Script transforms are the default. Package transforms are an optimization path.

### 10.2 Script Transform Contract (Canonical)

```
┌────────────────────────────────────────────────────────────┐
│                  Script Transform                           │
│                                                            │
│  Environment variables:                                    │
│    $ORGLOOP_SOURCE      — source ID                        │
│    $ORGLOOP_TARGET      — target actor ID                  │
│    $ORGLOOP_EVENT_TYPE  — event type string                 │
│    $ORGLOOP_EVENT_ID    — event ID                          │
│    $ORGLOOP_ROUTE       — route name                        │
│                                                            │
│  stdin:  Full event JSON                                   │
│  stdout: Modified event JSON → event continues              │
│          Empty → event is dropped                           │
│  exit 0: Success (check stdout for pass/drop)               │
│  exit 1: Event is dropped (explicit filter)                 │
│  exit 2+: Transform error (event is NOT dropped,            │
│           logged as error, event continues)                  │
│                                                            │
│  Timeout: 30s default (configurable per-transform)          │
└────────────────────────────────────────────────────────────┘
```

**Important design decision:** Exit code >= 2 means a transform *error*, not a filter. This prevents a buggy transform from silently dropping events. The default behavior (fail-open) passes the event through on error. For security transforms, use `on_error: drop` or `on_error: halt` to override this (see section 10.4).

### 10.4 Transform Error Policy (`on_error`)

By default, transforms fail-open: if a transform throws or exits with code >= 2, the event passes through unmodified. This is safe for data transforms (enrichment, dedup) but dangerous for **security transforms** (injection scanning, payload validation) where a failing scanner silently passing malicious content defeats its purpose.

The `on_error` field controls what happens when a transform errors:

| Policy | Behavior | Use Case |
|--------|----------|----------|
| `pass` | Event passes through unmodified (default, backwards-compatible) | Data enrichment, metadata, timestamps |
| `drop` | Event is silently dropped | Security scanning, injection detection |
| `halt` | Pipeline halts, error is emitted to the engine | Critical validation, compliance gates |

**Definition-level** (applies to all routes using this transform):

```yaml
transforms:
  - name: injection-scanner
    type: package
    package: "@orgloop/transform-injection-scanner"
    on_error: drop    # If scanner fails, don't deliver the event
```

**Route-level override** (applies only to this route, overrides definition-level):

```yaml
routes:
  - name: secure-delivery
    when:
      source: github-prs
      events: [resource.changed]
    transforms:
      - ref: injection-scanner
        on_error: halt    # Override: halt pipeline instead of just dropping
    then:
      actor: openclaw-agent
```

Route-level `on_error` takes precedence over definition-level. If neither is set, the default is `pass`.

**Log phases for error policies:**

| Phase | Policy | Severity |
|-------|--------|----------|
| `transform.error` | `pass` | warn |
| `transform.error_drop` | `drop` | warn |
| `transform.error_halt` | `halt` | error |

All three policies log the error. The difference is what happens to the event afterward.

### 10.3 Built-in Transforms

> **Implementation status:** Only `@orgloop/transform-filter` and `@orgloop/transform-dedup` are implemented. All other transforms listed below are proposed designs for future implementation.

#### Implemented

**`@orgloop/transform-filter`**

General-purpose filter supporting match/exclude with dot-path field matching and jq subprocess mode.

```yaml
transforms:
  - ref: filter
    config:
      # jq expression — must return truthy for event to pass
      jq: '.provenance.author_type == "team_member"'

  - ref: filter
    config:
      # match (AND — all criteria must match)
      match:
        provenance.author_type: team_member
        type: resource.changed

  - ref: filter
    config:
      # match_any (OR — any criterion can match)
      match_any:
        provenance.platform_event: "pull_request.review_submitted,pull_request_review_comment"

  - ref: filter
    config:
      # Exclude patterns (OR — any match drops the event)
      exclude:
        provenance.author:
          - "dependabot[bot]"
          - "renovate[bot]"
```

Three match modes: `match` (AND), `match_any` (OR), `exclude` (OR drop). Comma-separated string values are expanded into arrays automatically. jq mode requires `jq` on the system. Match/exclude mode is pure TypeScript (no external dependency).

**`@orgloop/transform-dedup`**

Deduplicates events within a configurable time window using SHA-256 content hashing.

```yaml
transforms:
  - ref: dedup
    config:
      # Deduplicate on these fields
      key:
        - source
        - type
        - payload.pr_number
      window: 5m             # Time window for dedup
      store: memory          # "memory" (in-process hash set)
```

Periodic cleanup removes expired entries. Hash-based comparison prevents exact-duplicate events from reaching actors.

#### Proposed (Not Yet Implemented)

##### Security

**`@orgloop/transform-injection-scanner`**

Scans event payloads for prompt injection patterns. Lightweight heuristic-based (not LLM-based — transforms should be fast and deterministic).

```yaml
transforms:
  - ref: injection-scanner
    config:
      action: tag           # "tag" (add warning) or "drop" (filter event)
      patterns: default     # Use built-in pattern set
      # custom_patterns:    # Additional patterns
      #   - "ignore previous instructions"
      #   - "system prompt"
```

Detection patterns:
- Known injection prefixes ("ignore previous", "system:", "you are now")
- Unicode obfuscation (homoglyphs, invisible characters)
- Excessive special characters in text fields
- Base64-encoded suspicious content

On detection: adds `provenance.security.injection_risk: true` to the event (tag mode) or drops it (drop mode).

**`@orgloop/transform-sanitizer`**

Strips or redacts sensitive data from event payloads before delivery.

```yaml
transforms:
  - ref: sanitizer
    config:
      redact:
        - "payload.**.password"
        - "payload.**.secret"
        - "payload.**.token"
      strip_html: true
      max_payload_size: 100KB
```

##### Filtering

**`@orgloop/transform-rate-limit`**

Rate-limits events per source, per route, or per custom key.

```yaml
transforms:
  - ref: rate-limit
    config:
      max: 10
      window: 1m
      key: source            # Rate limit per source
      # key: "payload.pr_number"  # Rate limit per PR
      action: drop           # "drop" or "delay" (queue and release later)
```

#### Enrichment

**`@orgloop/transform-timestamp`**

Normalizes timestamps across sources to a canonical format and adds processing metadata.

```yaml
transforms:
  - ref: timestamp
    config:
      normalize_to: UTC
      add_fields:
        processed_at: now
        processing_delay_ms: auto   # Time between event timestamp and processing
```

This transform is lightweight but valuable — it ensures all events have consistent timestamp formats regardless of source platform.

**`@orgloop/transform-metadata`**

Injects additional metadata into events.

```yaml
transforms:
  - ref: metadata
    config:
      add:
        environment: production
        orgloop_version: auto
        hostname: auto
```

#### Domain-Specific

**GitHub Event Normalizer** (built into `@orgloop/connector-github`)

Not a standalone transform — event normalization is the connector's responsibility. The GitHub connector maps:

```
pull_request.review_submitted    → resource.changed
pull_request_review_comment      → resource.changed
issue_comment (on PR)            → resource.changed
pull_request.closed/merged       → resource.changed
workflow_run.completed (failure)  → resource.changed
```

And populates:
```json
{
  "provenance": {
    "platform": "github",
    "platform_event": "pull_request.review_submitted",
    "author": "brandonchoe",
    "author_type": "team_member",
    "repo": "my-org/my-repo",
    "pr_number": 1234,
    "url": "https://github.com/..."
  }
}
```

**Linear Event Normalizer** (built into `@orgloop/connector-linear`)

Maps Linear GraphQL responses:
```
issue.updated (state change)     → resource.changed
issue.updated (comment added)    → resource.changed
issue.created                    → resource.changed
```

And populates:
```json
{
  "provenance": {
    "platform": "linear",
    "platform_event": "issue.updated",
    "author": "Alice Smith",
    "author_type": "team_member",
    "issue_id": "ENG-123",
    "state": "In Review",
    "url": "https://linear.app/..."
  }
}
```
