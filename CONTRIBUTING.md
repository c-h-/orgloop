# Contributing to OrgLoop

Hey, thanks for considering contributing to OrgLoop! Whether you're fixing a typo, building a connector, or proposing a new feature, we appreciate the help.

## Getting Started

```bash
# Clone the repo
git clone https://github.com/orgloop/orgloop.git
cd orgloop

# Install dependencies (requires pnpm 9+ and Node 22+)
pnpm install

# Enable pre-push hook (runs build + test + typecheck + lint before every push)
git config core.hooksPath scripts

# Build all packages
pnpm build

# Run tests
pnpm test

# Lint
pnpm lint
```

The project uses **pnpm workspaces** + **Turborepo** for the monorepo, **TypeScript** across all packages, **Biome** for linting and formatting, and **Vitest** for testing.

### Workspace Layout

```
packages/
  core/       — Runtime engine (event bus, router, scheduler)
  sdk/        — Plugin development kit (interfaces, test harness)
  cli/        — orgloop CLI
  server/     — HTTP API server
connectors/
  github/     — GitHub source connector
  linear/     — Linear source connector
  claude-code/ — Claude Code actor connector
  openclaw/   — OpenClaw actor connector
  webhook/    — Webhook source/actor connector
transforms/
  filter/     — Event filter transform
  dedup/      — Deduplication transform
loggers/
  file/       — File-based structured logger
  console/    — Console logger
```

## Building a Connector

Connectors are the primary contribution path. They bridge OrgLoop's event model and external platforms.

### Source Connector

A source connector polls an external system for new events. Implement the `SourceConnector` interface from `@orgloop/sdk`:

```typescript
import type { SourceConnector, PollResult, SourceConfig, OrgLoopEvent } from '@orgloop/sdk';
import { buildEvent } from '@orgloop/sdk';

export class MySourceConnector implements SourceConnector {
  readonly id = 'my-source';

  async init(config: SourceConfig): Promise<void> {
    // Set up API clients, validate config, etc.
  }

  async poll(checkpoint: string | null): Promise<PollResult> {
    // Fetch events since the last checkpoint
    const events: OrgLoopEvent[] = [
      buildEvent({
        source: this.id,
        type: 'resource.changed',
        provenance: { platform: 'my-platform' },
        payload: { /* ... */ },
      }),
    ];
    return { events, checkpoint: 'new-checkpoint-value' };
  }

  async shutdown(): Promise<void> {
    // Clean up resources
  }
}
```

The runtime calls `poll()` on a configurable interval. Return an opaque checkpoint string so the runtime can resume from where you left off after a restart.

### Actor (Target) Connector

An actor connector delivers events to an external system. Implement the `ActorConnector` interface:

```typescript
import type { ActorConnector, DeliveryResult, ActorConfig, OrgLoopEvent, RouteDeliveryConfig } from '@orgloop/sdk';

export class MyActorConnector implements ActorConnector {
  readonly id = 'my-actor';

  async init(config: ActorConfig): Promise<void> {
    // Set up API clients, validate config, etc.
  }

  async deliver(event: OrgLoopEvent, routeConfig: RouteDeliveryConfig): Promise<DeliveryResult> {
    // Deliver the event to the target system
    return { status: 'delivered' };
  }

  async shutdown(): Promise<void> {
    // Clean up resources
  }
}
```

### Connector Registration

Your connector package's default export should be a function returning a `ConnectorRegistration`:

```typescript
import type { ConnectorRegistration } from '@orgloop/sdk';

export default function register(): ConnectorRegistration {
  return {
    id: 'my-connector',
    source: MySourceConnector,  // if it's a source
    target: MyActorConnector,   // if it's a target
    configSchema: { /* JSON Schema for config validation */ },
    setup: {
      env_vars: ['MY_API_TOKEN'],
    },
  };
}
```

### Naming Convention

- Community connectors: `orgloop-connector-*` (e.g., `orgloop-connector-jira`)
- First-party connectors: `@orgloop/connector-*` (e.g., `@orgloop/connector-github`)

### Testing Connectors

The SDK provides mock helpers for testing. See `@orgloop/sdk` exports: `MockSource`, `MockActor`, `createTestEvent`, and `createTestContext`.

## Building a Transform

Transforms modify, filter, or enrich events as they flow through routes. Two modes:

### Script-Based Transform

A shell script that reads a JSON event from stdin and writes the (optionally modified) event to stdout. Return nothing (empty output) to drop the event.

### Package-Based Transform

Implement the `Transform` interface from `@orgloop/sdk`:

```typescript
import type { Transform, TransformContext, OrgLoopEvent } from '@orgloop/sdk';

export class MyTransform implements Transform {
  readonly id = 'my-transform';

  async init(config: Record<string, unknown>): Promise<void> {}

  async execute(event: OrgLoopEvent, context: TransformContext): Promise<OrgLoopEvent | null> {
    // Return the event to pass it through
    // Return null to drop it
    // Return a modified event to transform it
    return event;
  }

  async shutdown(): Promise<void> {}
}
```

Export a `TransformRegistration` as the package's default export.

## Branch Naming

- `fix/*` -- Bug fixes
- `feat/*` -- New features
- `docs/*` -- Documentation changes

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(connector): add Jira source connector
fix(core): handle empty checkpoint on first poll
docs: update CONTRIBUTING with transform examples
chore: bump vitest to v3.1
```

## PR Process

1. **Fork** the repository
2. **Branch** from `main` using the naming convention above
3. **Make your changes** -- keep PRs focused on a single concern
4. **Test** -- run `pnpm test` and ensure your changes are covered
5. **Lint** -- run `pnpm lint` and fix any issues
6. **Open a PR** against `main` with a clear description

## AI-Assisted PRs Welcome

We encourage using AI tools (Claude, Copilot, etc.) to help write code. If your PR was AI-assisted, please:

- [ ] Mark the PR as AI-assisted in the description
- [ ] Note the degree of AI involvement (generated, reviewed, pair-programmed)
- [ ] Include relevant prompts or conversation logs if possible
- [ ] Confirm that you understand the code and have reviewed it yourself

AI-assisted contributions are held to the same quality bar as any other contribution. The checklist helps reviewers understand context, not gatekeep.

## Where to Start

- Look for issues labeled **`good first issue`** -- these are scoped and well-defined
- Check issues labeled **`connector request`** -- building a new connector is a great first contribution
- Browse the existing connectors in `connectors/` to see the patterns in use
- Read the SDK source in `packages/sdk/src/` to understand the interfaces
