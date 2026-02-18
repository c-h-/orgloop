---
title: Glossary
description: Terminology and definitions used throughout OrgLoop.
---

Alphabetical reference of terms used in OrgLoop's documentation, configuration, and codebase.

### Actor

An entity that can be woken to do work when an event is delivered. An OpenClaw agent, a Claude Code team, a webhook endpoint, or a human via notification. Actors are instances of [actor connectors](#actor-connector) configured in [ConnectorGroup](/reference/config-schema/#actor-definition) YAML files. See [Five Primitives](/concepts/five-primitives/).

### Actor Connector

A plugin that implements the `ActorConnector` interface from `@orgloop/sdk`. Receives events via its `deliver()` method and sends them to an external system. Also called a "target connector." See [Building Connectors](/guides/connector-authoring/).

### `actor.stopped`

One of three [event types](#event-type). Emitted when an actor's session ends. Deliberately neutral -- OrgLoop observes that a session ended but makes no claim about success or failure. The receiving actor judges what it means. See [Event Taxonomy](/concepts/event-taxonomy/).

### Checkpoint

An opaque cursor string tracking a source's last-processed position. Returned by `poll()` and passed back on the next poll cycle. Enables crash recovery and deduplication. Stored by the `FileCheckpointStore` in `@orgloop/core`.

### Connector

A plugin package that bridges OrgLoop to an external system. A connector can provide a [source](#source-connector), a [target](#actor-connector), or both. Published as npm packages following the naming convention `@orgloop/connector-*` (first-party) or `orgloop-connector-*` (community). See [Building Connectors](/guides/connector-authoring/).

### Connector Registration

The `ConnectorRegistration` object exported by a connector's `register()` function. Contains the connector ID, source and/or target class constructors, config schema, and optional [setup metadata](#connector-setup) for CLI guidance.

### Connector Setup

Optional metadata in a `ConnectorRegistration` that provides onboarding guidance. Includes `env_vars` (with per-variable `description` and `help_url`) and `integrations` (external steps like hook installation). The CLI uses this to power `orgloop env` and `orgloop doctor`.

### Degraded Mode

A runtime state where some actors are unavailable but the system continues operating. Events are queued for unavailable actors and delivered when they come online. OrgLoop is designed to function in degraded mode rather than fail entirely.

### Event

A normalized data structure representing something that happened. All events share a common [envelope](#event-envelope) with connector-specific [payload](#payload). See [Event Schema](/reference/event-schema/).

### Event Bus

The internal message-passing abstraction that receives events from sources and distributes them to the router. Implementations include `InMemoryBus` (default) and `FileWalBus` (write-ahead log for durability).

### Event Envelope

The standardized wrapper around every event: `id`, `timestamp`, `source`, `type`, `provenance`, `payload`, and `trace_id`. Defined in the [Event Schema](/reference/event-schema/).

### Event Type

One of three values carried by every event: `resource.changed`, `actor.stopped`, or `message.received`. Minimal by design. See [Event Taxonomy](/concepts/event-taxonomy/).

### Launch Prompt

A focused Markdown SOP file delivered alongside an event via a route's `with.prompt_file` field. Provides situational instructions telling the actor how to approach a specific event type. Same actor, different prompts per route. See [Config Schema: with](/reference/config-schema/#with--launch-context).

### Logger

A passive observer that records pipeline activity. Every event ingestion, transform result, route match, and delivery attempt is captured. Loggers are first-class [primitives](/concepts/five-primitives/), not optional add-ons. Implementations include `@orgloop/logger-file` (buffered JSONL with rotation) and `@orgloop/logger-console` (ANSI colored output).

### `message.received`

One of three [event types](#event-type). Represents a human or system message -- direct messages, chat commands, manual triggers, and notifications that represent intent rather than a state change.

### Project

A directory containing an `orgloop.yaml` config file and a `package.json` listing connector, transform, and logger dependencies. Projects are the unit of deployment in OrgLoop -- each project defines a complete organizational topology (sources, actors, routes, transforms, loggers, and SOPs). Projects are package-native: connectors are npm packages installed via `npm install`, not module manifests. See [User Guide](/start/user-guide/).

### Organization as Code (OaC)

The paradigm of declaring organizational topology -- event sources, actors, routing, transforms, and logging -- in version-controlled configuration files. Analogous to Infrastructure as Code for servers. See [Manifesto](/vision/manifesto/).

### Payload

The connector-specific freeform JSON data carried by an event. Each connector defines its own payload shape. Consumers should not assume payload shapes from other connectors. See [Event Schema: Payload](/reference/event-schema/#payload).

### Poll

The mechanism by which source connectors fetch new events. Sources implement a `poll(checkpoint)` method called on a configured interval. OrgLoop defaults to polling over webhooks for zero inbound attack surface.

### Provenance

The origin metadata object on every event. Contains `platform`, `platform_event`, `author`, and `author_type`. Allows additional connector-specific fields. Used by transforms for filtering (e.g., dropping bot events) and by loggers for audit trails.

### `resource.changed`

One of three [event types](#event-type). The most common type. Represents a meaningful state change in an external system: a PR was reviewed, a ticket moved, CI completed, a deploy finished.

### Route

Declarative wiring between a source event and an actor delivery. Specifies `when` (trigger conditions), optional `transforms` (pipeline), `then` (target actor and config), and optional `with` (launch prompt). Routes are explicit allow-lists -- actors only see events their routes match. See [Five Primitives](/concepts/five-primitives/) and [Config Schema: Routes](/reference/config-schema/#route-definition).

### Route Matching

The process by which the router determines which routes apply to a given event. Matches on `source`, `events` array, and optional `filter` (dot-path conditions on event fields). An event can match multiple routes and be delivered to multiple actors.

### Source

An external system that emits events. A GitHub repository, a Linear project, a Claude Code session, a webhook endpoint. Sources are instances of [source connectors](#source-connector) configured in ConnectorGroup YAML files. See [Five Primitives](/concepts/five-primitives/).

### Source Connector

A plugin that implements the `SourceConnector` interface from `@orgloop/sdk`. Polls an external system for events via its `poll()` method, or exposes a `webhook()` handler for push-based sources. See [Building Connectors](/guides/connector-authoring/).

### Trace ID

A `trc_`-prefixed identifier assigned by the engine when an event enters the pipeline. Groups all log entries for a single event's journey through routing, transforms, and delivery. Use `orgloop logs --event <id>` to follow a trace.

### Transform

An optional pipeline step that modifies, filters, or enriches events between ingestion and delivery. Can be a published package (implementing the `Transform` interface) or a shell script (stdin/stdout contract). Transforms are sequential -- order matters. See [Five Primitives](/concepts/five-primitives/) and [Building Transforms](/guides/transform-authoring/).

### Transform Pipeline

The ordered sequence of transforms applied to an event after route matching and before actor delivery. Defined per-route via the `transforms` array. If any transform drops the event, the pipeline stops and the event is not delivered.
