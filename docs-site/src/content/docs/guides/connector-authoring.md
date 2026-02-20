---
title: Building Connectors
description: How to build source and actor connectors for OrgLoop.
---

Connectors bridge external systems to OrgLoop's event model. A connector can provide a **source** (inbound events via polling), a **target/actor** (outbound delivery), or both. They are the primary extension point for integrating new platforms.

## Source connector

A source connector polls an external system for new events on a schedule. Implement the `SourceConnector` interface from `@orgloop/sdk`.

### Interface

```typescript
interface SourceConnector {
  readonly id: string;
  init(config: SourceConfig): Promise<void>;
  poll(checkpoint: string | null): Promise<PollResult>;
  shutdown(): Promise<void>;
}
```

| Method | Purpose |
|--------|---------|
| `init(config)` | Set up API clients, validate credentials, parse connector-specific config |
| `poll(checkpoint)` | Fetch new events since the last checkpoint. Return `{ events, checkpoint }` |
| `shutdown()` | Clean up resources (close connections, flush buffers) |

The runtime calls `poll()` on the configured interval. The `checkpoint` is an opaque string your connector produces -- the runtime stores it and passes it back on the next poll so you can resume where you left off after a restart.

### Full example: RSS feed source

```typescript
import type { SourceConnector, SourceConfig, PollResult, OrgLoopEvent } from '@orgloop/sdk';
import { buildEvent } from '@orgloop/sdk';

export class RssFeedSource implements SourceConnector {
  readonly id = 'rss-feed';
  private feedUrl = '';

  async init(config: SourceConfig): Promise<void> {
    this.feedUrl = config.config.feed_url as string;
    if (!this.feedUrl) {
      throw new Error('rss-feed connector requires config.feed_url');
    }
  }

  async poll(checkpoint: string | null): Promise<PollResult> {
    const response = await fetch(this.feedUrl);
    const text = await response.text();
    const items = parseRssItems(text); // your XML parsing logic

    const since = checkpoint ? new Date(checkpoint) : new Date(0);
    const newItems = items.filter(item => new Date(item.pubDate) > since);

    const events: OrgLoopEvent[] = newItems.map(item =>
      buildEvent({
        source: this.id,
        type: 'resource.changed',
        provenance: {
          platform: 'rss',
          platform_event: 'item.published',
          author: item.author ?? 'unknown',
        },
        payload: {
          title: item.title,
          link: item.link,
          description: item.description,
        },
      })
    );

    const latestDate = newItems.length > 0
      ? newItems[0].pubDate
      : checkpoint ?? new Date().toISOString();

    return { events, checkpoint: latestDate };
  }

  async shutdown(): Promise<void> {
    // Nothing to clean up
  }
}
```

Use `buildEvent()` from the SDK to normalize raw platform data into a well-formed `OrgLoopEvent`. It fills in `id`, `timestamp`, and `trace_id` automatically.

## Target (actor) connector

A target connector delivers events to an external system. Implement the `ActorConnector` interface from `@orgloop/sdk`.

### Interface

```typescript
interface ActorConnector {
  readonly id: string;
  init(config: ActorConfig): Promise<void>;
  deliver(event: OrgLoopEvent, routeConfig: RouteDeliveryConfig): Promise<DeliveryResult>;
  shutdown(): Promise<void>;
}
```

| Method | Purpose |
|--------|---------|
| `init(config)` | Set up API client, validate credentials |
| `deliver(event, routeConfig)` | Deliver event to the target system. `routeConfig` includes actor-specific config from the route's `then.config` plus the resolved `launch_prompt` if the route has a `with` block |
| `shutdown()` | Clean up resources |

### Example: Slack webhook target

```typescript
import type { ActorConnector, ActorConfig, OrgLoopEvent, RouteDeliveryConfig, DeliveryResult } from '@orgloop/sdk';

export class SlackWebhookTarget implements ActorConnector {
  readonly id = 'slack-webhook';
  private webhookUrl = '';

  async init(config: ActorConfig): Promise<void> {
    this.webhookUrl = config.config.webhook_url as string;
    if (!this.webhookUrl) {
      throw new Error('slack-webhook connector requires config.webhook_url');
    }
  }

  async deliver(event: OrgLoopEvent, routeConfig: RouteDeliveryConfig): Promise<DeliveryResult> {
    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `[${event.type}] ${event.source}: ${JSON.stringify(event.payload)}`,
      }),
    });

    if (!response.ok) {
      return { status: 'error', error: new Error(`Slack returned ${response.status}`) };
    }

    return { status: 'delivered' };
  }

  async shutdown(): Promise<void> {}
}
```

## Registration

Every connector package exports a `register()` function as its default export. This returns a `ConnectorRegistration` that tells the runtime what the connector provides.

```typescript
import type { ConnectorRegistration } from '@orgloop/sdk';
import { RssFeedSource } from './source.js';

export default function register(): ConnectorRegistration {
  return {
    id: 'rss-feed',
    source: RssFeedSource,
    configSchema: {
      type: 'object',
      required: ['feed_url'],
      properties: {
        feed_url: { type: 'string', description: 'RSS feed URL' },
      },
    },
    setup: {
      env_vars: [
        {
          name: 'RSS_FEED_URL',
          description: 'URL of the RSS feed to poll',
        },
      ],
    },
  };
}
```

A connector can provide both `source` and `target` in a single registration (see `@orgloop/connector-webhook` for an example).

## ConnectorSetup metadata

The `setup` field in the registration provides onboarding metadata that the CLI uses for `orgloop env`, `orgloop doctor`, and error messages. This is how OrgLoop delivers actionable guidance during setup.

```typescript
setup: {
  env_vars: [
    {
      name: 'GITHUB_TOKEN',
      description: 'Personal access token with repo scope',
      help_url: 'https://github.com/settings/tokens/new?scopes=repo,read:org',
    },
  ],
  integrations: [
    {
      id: 'claude-code-hook',
      description: 'Register a post-exit hook in Claude Code settings',
      platform: 'claude-code',
      command: 'claude config set hookUrl http://localhost:18790/hook',
    },
  ],
}
```

When a required environment variable is missing, the CLI renders:

```
  ✗ GITHUB_TOKEN  — Personal access token with repo scope
    → https://github.com/settings/tokens/new?scopes=repo,read:org
```

Every connector should populate `ConnectorSetup` with `env_vars` including per-variable `description` and `help_url`. This is the minimum for Level 3 developer experience.

## Package structure

```
connectors/my-service/
  package.json
  src/
    index.ts          # register() default export
    source.ts         # SourceConnector implementation (if source)
    target.ts         # ActorConnector implementation (if target)
    __tests__/
      source.test.ts
```

### package.json

```json
{
  "name": "orgloop-connector-my-service",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "dependencies": {
    "@orgloop/sdk": "workspace:*"
  }
}
```

## Naming convention

- First-party: `@orgloop/connector-*` (e.g., `@orgloop/connector-github`)
- Community: `orgloop-connector-*` (e.g., `orgloop-connector-jira`)

## Testing

The SDK provides mock helpers for testing connectors:

```typescript
import { createTestEvent, createTestContext, MockSource, MockActor } from '@orgloop/sdk';

// Create a test event
const event = createTestEvent({
  source: 'my-service',
  type: 'resource.changed',
  provenance: { platform: 'my-service' },
});

// Use MockSource/MockActor for integration tests
const mockSource = new MockSource('test-source');
const mockActor = new MockActor('test-actor');
```

Connectors depend only on `@orgloop/sdk`, never on `@orgloop/core`. This keeps the dependency footprint small and ensures connectors are testable in isolation.

## Publishing

1. Build: `pnpm build`
2. Test: `pnpm test`
3. Publish: `npm publish` (or `npm publish --access public` for scoped packages)
4. Users install: `npm install orgloop-connector-my-service`
5. Users add to their project: `orgloop add connector my-service --package orgloop-connector-my-service`

See the existing connectors in `connectors/` ([source on GitHub](https://github.com/orgloop/orgloop/tree/main/connectors)) for real-world examples of the pattern.
