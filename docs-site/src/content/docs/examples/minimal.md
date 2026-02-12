---
title: "Example: Minimal"
description: The simplest possible OrgLoop setup — one source, one logger.
---

import { Aside } from '@astrojs/starlight/components';

<Aside type="tip" title="Start here">
This is the best place to start with OrgLoop. A webhook source and a console logger -- one route connecting them. No external services required.
</Aside>

The simplest possible OrgLoop setup. One webhook source, one console logger, no environment variables. Use this to understand the config format before building anything real.

## What this example shows

- The `orgloop.yaml` project file and how it references external config files
- Connector and logger configuration in separate YAML files
- How to send a test event and see it logged

## Prerequisites

- Node.js >= 22
- OrgLoop CLI installed (`npm install -g @orgloop/cli`)
- **No accounts or API tokens required**

## Setup

Copy the example and run it:

```bash
cp -r examples/minimal my-project
cd my-project
orgloop validate
orgloop start
```

Or scaffold from scratch:

```bash
orgloop init    # select "webhook" when prompted for connectors
cd my-project
orgloop validate
orgloop start
```

## Configuration

The example uses three files. No environment variables are required.

### `orgloop.yaml`

The project root. References connectors and loggers by path.

```yaml
# orgloop.yaml — Minimal example
# The simplest possible OrgLoop setup: one source, one actor, one route.

apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: minimal-org
  description: "Minimal OrgLoop example"

defaults:
  poll_interval: 5m
  log_level: info

connectors:
  - connectors/webhook.yaml

loggers:
  - loggers/default.yaml
```

### `connectors/webhook.yaml`

A generic webhook source that listens for inbound HTTP POST requests.

```yaml
apiVersion: orgloop/v1alpha1
kind: ConnectorGroup

sources:
  - id: webhook
    description: Generic webhook receiver
    connector: "@orgloop/connector-webhook"
    config:
      path: "/webhook"
    emits:
      - resource.changed
      - message.received
```

### `loggers/default.yaml`

Console logger with color output.

```yaml
apiVersion: orgloop/v1alpha1
kind: LoggerGroup

loggers:
  - name: console-log
    type: "@orgloop/logger-console"
    config:
      level: info
      color: true
```

## Testing

Send a test event with curl:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"type": "test", "message": "hello from orgloop"}'
```

## What you will see

The console logger prints each event as it flows through the system:

```
[info] event.ingested   webhook  resource.changed  evt_abc123
[info] event.routed     webhook  resource.changed  (no matching routes)
```

Since this example has no routes or actors, events are ingested and logged but not delivered anywhere. That is the point -- it shows the config format and event lifecycle without any external dependencies.

## Next steps

Once you are comfortable with the config format, add a real source:

- **[GitHub to Slack](/examples/github-to-slack/)** -- one source, one actor, two tokens. The simplest real-world setup.
- **[Multi-Agent Supervisor](/examples/multi-agent-supervisor/)** -- the feedback loop pattern with Claude Code and a supervisor agent.
- **[Engineering Org](/examples/engineering-org/)** -- the full multi-source setup with GitHub, Linear, Claude Code, and OpenClaw.
