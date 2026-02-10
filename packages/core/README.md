# @orgloop/core

OrgLoop runtime engine -- library-first event routing for autonomous AI organizations. Load a config, wire up sources/actors/transforms/loggers, and run the event loop.

## Install

```bash
npm install @orgloop/core
```

## Usage

```typescript
import { OrgLoop, loadConfig, InMemoryBus } from '@orgloop/core';

// Load and validate an orgloop.yaml
const config = await loadConfig('./orgloop.yaml');

// Create and start the engine
const engine = new OrgLoop({
  config,
  bus: new InMemoryBus(),
  sources: { github: myGitHubSource },
  actors: { reviewer: myReviewerActor },
});

await engine.start();

// Later...
await engine.stop();
```

## API

### Engine

- `OrgLoop` -- main engine class (extends EventEmitter)
- `OrgLoopOptions` -- engine constructor options
- `EngineStatus` -- runtime status type

### Config

- `loadConfig(path, options?)` -- load and validate YAML config with env var substitution
- `buildConfig(raw)` -- build config from an object

### Event bus

- `InMemoryBus` -- default in-memory event bus
- `FileWalBus` -- durable write-ahead-log bus

### Stores

- `FileCheckpointStore` / `InMemoryCheckpointStore` -- source deduplication checkpoints
- `FileEventStore` / `InMemoryEventStore` -- event persistence

### Routing and transforms

- `matchRoutes(event, routes)` -- match events to routes using dot-path filters
- `executeTransformPipeline(event, transforms, options)` -- run sequential transforms

### Infrastructure

- `Scheduler` -- manages poll intervals with graceful start/stop
- `LoggerManager` -- fan-out to multiple loggers, error-isolated
- `WebhookServer` -- HTTP server for webhook-based sources

### Errors

- `OrgLoopError`, `ConfigError`, `ConnectorError`, `TransformError`, `DeliveryError`, `SchemaError`

## Documentation

Full documentation at [orgloop.ai](https://orgloop.ai)

## License

MIT
