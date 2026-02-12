# @orgloop/core

OrgLoop runtime engine -- library-first event routing for autonomous AI organizations. Multi-module runtime with independent module lifecycle, shared infrastructure, and backward-compatible single-module API.

## Install

```bash
npm install @orgloop/core
```

## Usage

### Multi-module (Runtime)

```typescript
import { Runtime, InMemoryBus } from '@orgloop/core';

const runtime = new Runtime({ bus: new InMemoryBus() });
await runtime.start();

// Load modules dynamically
await runtime.loadModule(
  { name: 'engineering', sources: [...], actors: [...], routes: [...], transforms: [], loggers: [] },
  { sources: mySourcesMap, actors: myActorsMap }
);

// Load more modules without restarting
await runtime.loadModule(anotherModuleConfig, anotherConnectors);

// Manage modules at runtime
await runtime.reloadModule('engineering');
await runtime.unloadModule('engineering');

await runtime.stop();
```

### Single-module (OrgLoop wrapper)

```typescript
import { OrgLoop, loadConfig } from '@orgloop/core';

// Backward-compatible API -- creates a Runtime with one "default" module
const config = await loadConfig('./orgloop.yaml');
const loop = new OrgLoop(config, {
  sources: mySourcesMap,
  actors: myActorsMap,
});

await loop.start();
await loop.stop();
```

## API

### Runtime (multi-module)

- `Runtime` -- multi-module runtime class (extends EventEmitter)
- `RuntimeOptions` -- runtime constructor options (bus, httpPort, circuitBreaker, dataDir)
- `LoadModuleOptions` -- options for loadModule() (sources, actors, transforms, loggers, checkpointStore)

### Engine (single-module wrapper)

- `OrgLoop` -- backward-compatible wrapper around Runtime (extends EventEmitter)
- `OrgLoopOptions` -- engine constructor options
- `EngineStatus` -- runtime status type

### Module lifecycle

- `ModuleInstance` -- per-module resource container with lifecycle (loading/active/unloading/removed)
- `ModuleRegistry` -- singleton module name registry
- `ModuleConfig` -- module configuration type
- `ModuleContext` -- module-scoped context

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
- `WebhookServer` -- HTTP server for webhook sources and control API

### Errors

- `OrgLoopError`, `ConfigError`, `ConnectorError`, `TransformError`, `DeliveryError`, `SchemaError`
- `ModuleConflictError`, `ModuleNotFoundError`, `RuntimeError`

## Documentation

Full documentation at [orgloop.ai](https://orgloop.ai)

## License

MIT
