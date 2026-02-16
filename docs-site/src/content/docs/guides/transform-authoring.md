---
title: Building Transforms
description: How to build script and package transforms for event filtering and enrichment.
---

Transforms are pipeline steps that sit between sources and actors. They filter, modify, or enrich events as they flow through routes. OrgLoop supports two modes: **script transforms** (shell scripts, any language) and **package transforms** (TypeScript classes).

## Script transforms

The simplest approach. Write a shell script that reads an event JSON from stdin and writes the modified event to stdout. No SDK dependency required -- any language that reads stdin and writes stdout works.

### Contract

| Channel | Behavior |
|---------|----------|
| stdin | Full event JSON |
| stdout (non-empty) | Modified event JSON -- event continues through the pipeline |
| stdout (empty) or exit 1 | Event is dropped |
| exit 0 | Success (check stdout for pass/drop) |
| exit >= 2 | Transform error -- event passes through (fail-open), error logged |

Environment variables are available during execution:

- `$ORGLOOP_SOURCE` -- source ID
- `$ORGLOOP_TARGET` -- target actor ID
- `$ORGLOOP_EVENT_TYPE` -- event type string
- `$ORGLOOP_EVENT_ID` -- event ID
- `$ORGLOOP_ROUTE` -- route name

Default timeout: 30 seconds (configurable per-transform).

### Example: bot noise filter

```bash
#!/bin/bash
# transforms/drop-bot-noise.sh
# Drops events from bot authors.

EVENT=$(cat)
AUTHOR_TYPE=$(echo "$EVENT" | jq -r '.provenance.author_type // "unknown"')

if [[ "$AUTHOR_TYPE" == "bot" ]]; then
  # Empty stdout + exit 0 = drop
  exit 0
fi

echo "$EVENT"  # Pass through unchanged
```

Make the script executable and reference it in your transform definition:

```yaml
transforms:
  - name: drop-bot-noise
    type: script
    script: ./transforms/drop-bot-noise.sh
    timeout_ms: 5000
```

Script transforms can be written in any language. Here is the same filter in Python:

```python
#!/usr/bin/env python3
import sys, json

event = json.load(sys.stdin)
if event.get("provenance", {}).get("author_type") == "bot":
    sys.exit(0)  # drop

json.dump(event, sys.stdout)
```

### Exit code design

Exit code >= 2 means a transform *error*, not a filter decision. This prevents a buggy transform from silently dropping events. If a transform crashes, the event continues through the pipeline (fail-open for availability) and the error is logged.

## Package transforms

For complex or reusable transforms, implement the `Transform` interface from `@orgloop/sdk`. Package transforms run in-process (no subprocess overhead) and have access to the full TypeScript type system.

### Interface

```typescript
interface Transform {
  readonly id: string;
  init(config: Record<string, unknown>): Promise<void>;
  execute(event: OrgLoopEvent, context: TransformContext): Promise<OrgLoopEvent | null>;
  shutdown(): Promise<void>;
}
```

| Method | Purpose |
|--------|---------|
| `init(config)` | Parse configuration, set up any resources |
| `execute(event, context)` | Process the event. Return the event (optionally modified) to continue, or `null` to drop it |
| `shutdown()` | Clean up resources |

The `TransformContext` provides metadata about the current pipeline step:

```typescript
interface TransformContext {
  source: string;      // Source connector ID
  target: string;      // Target actor ID
  eventType: string;   // Event type string
  routeName: string;   // Route name
}
```

### Example: rate limiter transform

```typescript
import type { OrgLoopEvent, Transform, TransformContext } from '@orgloop/sdk';

export class RateLimitTransform implements Transform {
  readonly id = 'rate-limit';
  private maxPerWindow = 10;
  private windowMs = 60_000;
  private counts = new Map<string, { count: number; resetAt: number }>();

  async init(config: Record<string, unknown>): Promise<void> {
    if (config.max) this.maxPerWindow = config.max as number;
    if (config.window_ms) this.windowMs = config.window_ms as number;
  }

  async execute(event: OrgLoopEvent, context: TransformContext): Promise<OrgLoopEvent | null> {
    const key = `${context.source}:${context.routeName}`;
    const now = Date.now();
    const entry = this.counts.get(key);

    if (!entry || now >= entry.resetAt) {
      this.counts.set(key, { count: 1, resetAt: now + this.windowMs });
      return event;
    }

    if (entry.count >= this.maxPerWindow) {
      return null; // Drop -- rate limit exceeded
    }

    entry.count++;
    return event;
  }

  async shutdown(): Promise<void> {
    this.counts.clear();
  }
}
```

### Registration

Export a `TransformRegistration` as the package's default export:

```typescript
import type { TransformRegistration } from '@orgloop/sdk';
import { RateLimitTransform } from './rate-limit.js';

export function register(): TransformRegistration {
  return {
    id: 'rate-limit',
    transform: RateLimitTransform,
    configSchema: {
      type: 'object',
      properties: {
        max: { type: 'number', description: 'Max events per window' },
        window_ms: { type: 'number', description: 'Window size in milliseconds' },
      },
    },
  };
}
```

### Reference in YAML

```yaml
transforms:
  - name: rate-limit
    type: package
    package: "@orgloop/transform-rate-limit"
    config:
      max: 10
      window_ms: 60000
```

## Pipeline behavior

Transforms run **sequentially** in the order they appear in the route definition. Order matters.

```yaml
routes:
  - name: github-to-engineering
    when:
      source: github
      events: [resource.changed]
    transforms:
      - ref: drop-bot-noise       # Runs first
      - ref: dedup                 # Runs second (only sees non-bot events)
    then:
      actor: openclaw-engineering-agent
```

Key behaviors:

- A transform returning `null` (package) or producing empty stdout / exit 1 (script) **drops** the event. No further transforms or delivery occurs for that route.
- Transform errors are **fail-open** by default: the event passes through unchanged and the error is logged. This prevents buggy transforms from silently dropping events.
- Every transform result (pass, drop, error) is logged for audit with the event's trace ID.

## Built-in transforms

OrgLoop ships three built-in transforms:

### `@orgloop/transform-filter`

General-purpose event filter with dot-path field matching and optional jq mode.

```yaml
transforms:
  # AND matching -- all criteria must match
  - ref: filter
    config:
      match:
        provenance.author_type: team_member
        type: resource.changed

  # OR matching -- any criterion can match
  - ref: filter
    config:
      match_any:
        provenance.platform_event: "pull_request.review_submitted,pull_request_review_comment"

  # Exclude patterns -- any match drops the event
  - ref: filter
    config:
      exclude:
        provenance.author:
          - "dependabot[bot]"
          - "renovate[bot]"

  # jq mode -- full jq expression (requires jq installed)
  - ref: filter
    config:
      jq: '.provenance.author_type == "team_member"'
```

### `@orgloop/transform-dedup`

Deduplicates events within a configurable time window using SHA-256 content hashing.

```yaml
transforms:
  - ref: dedup
    config:
      key:
        - source
        - type
        - payload.pr_number
      window: 5m
      store: memory
```

### `@orgloop/transform-enrich`

Adds, copies, or computes fields on events as they flow through the pipeline.

```yaml
transforms:
  - ref: enrich
    config:
      add:
        metadata.processed_at: "{{ now }}"
      copy:
        metadata.source_platform: provenance.platform
```

## Testing

Use `MockTransform` from the SDK for integration tests:

```typescript
import { createTestEvent, MockTransform } from '@orgloop/sdk';

const event = createTestEvent({
  source: 'github',
  type: 'resource.changed',
});

const transform = new RateLimitTransform();
await transform.init({ max: 5, window_ms: 60000 });
const result = await transform.execute(event, {
  source: 'github',
  target: 'engineering',
  eventType: 'resource.changed',
  routeName: 'github-to-engineering',
});

expect(result).not.toBeNull();
```

See the [Building Connectors](/guides/connector-authoring/) guide for the full SDK test harness API.
