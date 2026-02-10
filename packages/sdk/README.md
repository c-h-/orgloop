# @orgloop/sdk

OrgLoop plugin development kit — interfaces, base classes, and test harnesses for building connectors, transforms, and loggers.

## Install

```bash
npm install @orgloop/sdk
```

## Usage

### Define a source connector

```typescript
import type { SourceConnector, PollResult, ConnectorRegistration } from '@orgloop/sdk';

const mySource: SourceConnector = {
  async init(config) { /* set up API clients */ },
  async poll(checkpoint): PollResult { /* fetch events since checkpoint */ },
  async shutdown() { /* cleanup */ },
};

export function register(): ConnectorRegistration {
  return { id: 'my-source', source: mySource };
}
```

### Write tests with the test harness

```typescript
import { MockSource, MockActor, createTestEvent, createTestContext } from '@orgloop/sdk';

const source = new MockSource([createTestEvent({ type: 'resource.changed' })]);
const actor = new MockActor();
const ctx = createTestContext();
```

## API

### Types

Core event types, config interfaces, and plugin contracts:

- `OrgLoopEvent`, `OrgLoopEventType` -- event envelope and type union
- `SourceConnector`, `ActorConnector` -- connector interfaces
- `ConnectorRegistration`, `ConnectorSetup` -- plugin registration
- `Transform`, `TransformContext`, `TransformRegistration` -- transform plugin
- `Logger`, `LoggerRegistration` -- logger plugin
- `ProjectConfig`, `OrgLoopConfig` -- configuration types
- `ModuleManifest`, `ModuleParameter` -- module system types

### Helpers

- `generateEventId()` / `generateTraceId()` -- ID generation
- `buildEvent(options)` -- construct well-formed events
- `validateEvent(event)` -- runtime validation
- `parseDuration(str)` -- parse duration strings like `"30s"`, `"5m"`
- `expandTemplate(template, context)` -- module template expansion

### Test harness

- `MockSource` -- configurable source with canned events
- `MockActor` -- records delivered events
- `MockTransform` -- pass-through or custom transform
- `MockLogger` -- captures log entries
- `createTestEvent(overrides?)` -- factory for test events
- `createTestContext()` -- factory for test contexts

## Documentation

Full documentation at [orgloop.ai](https://orgloop.ai)

## License

MIT
