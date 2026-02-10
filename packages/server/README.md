# @orgloop/server

OrgLoop HTTP API server -- exposes the OrgLoop engine over HTTP for remote management and integration.

> **Note:** This package is a placeholder for the v1.1 release. It currently re-exports `@orgloop/core`. The HTTP API surface is under design.

## Install

```bash
npm install @orgloop/server
```

## Status

Planned capabilities:

- REST API for engine lifecycle (start/stop/status)
- Event submission endpoint
- Route and config inspection
- WebSocket event streaming
- Health check endpoints

For now, use [`@orgloop/cli`](https://www.npmjs.com/package/@orgloop/cli) to run OrgLoop, or embed [`@orgloop/core`](https://www.npmjs.com/package/@orgloop/core) directly as a library.

## Documentation

Full documentation at [orgloop.ai](https://orgloop.ai)

## License

MIT
