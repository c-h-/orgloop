# Minimal Example

**Start here.** The simplest possible OrgLoop setup: a webhook source and a console logger, one route connecting them.

## What it does

- Receives events via a generic webhook
- Logs them to the console

This is the starting point for understanding OrgLoop's config format.

## Prerequisites

- Node.js >= 22
- OrgLoop CLI installed (`npm install -g @orgloop/cli`)
- **No accounts or API tokens required**

## Setup

```bash
orgloop init    # select "webhook" when prompted for connectors
cd my-project
orgloop add module @orgloop/module-minimal
orgloop validate
orgloop start
```

Or copy this directory and run directly:

```bash
cp -r examples/minimal my-project
cd my-project
orgloop validate
orgloop start
```

## Files

```
orgloop.yaml          # Project config — references connectors and loggers
connectors/
  webhook.yaml        # Generic webhook source
loggers/
  default.yaml        # Console logger
```

## Configuration

No environment variables required. The webhook source listens for inbound HTTP POST requests.

## Testing

Send a test event:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"type": "test", "message": "hello from orgloop"}'
```

You should see the event logged to the console.
