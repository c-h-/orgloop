# @orgloop/module-minimal

Minimal starter module -- 1 webhook source, 1 generic actor, 1 example route. Use this as a starting point to understand OrgLoop's module system or as a template for building your own modules.

## Install

```bash
orgloop add module minimal
```

## What's Included

**Sources (1):**
- **webhook** -- Generic webhook receiver listening on `/webhook`, emitting `resource.changed` and `message.received` events

**Actors (1):**
- **responder** -- Generic webhook delivery target, posts events to a configurable URL

**Routes (1):**
- **example** -- Forwards `resource.changed` events from the webhook source to the responder actor

**SOPs (1):** `example.md`

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `source` | yes | `webhook` | Name of the webhook source connector |
| `actor` | yes | `responder` | Name of the actor connector |

## Required Credentials

| Variable | Description |
|----------|-------------|
| `WEBHOOK_TARGET_URL` | URL where the responder actor delivers events |

## Documentation

Full documentation at [orgloop.ai](https://orgloop.ai)

## License

MIT
