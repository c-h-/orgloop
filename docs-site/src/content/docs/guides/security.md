---
title: Security
description: OrgLoop's security architecture — polling, transforms, least-privilege routing, and audit.
---

OrgLoop is the nervous system of your organization. Every event, every routing decision, every actor invocation flows through it. Security is architectural, not bolted on. The defaults are secure -- you opt *into* exposure, never out of it.

## Polling over webhooks

Sources use **outbound polling** by default. OrgLoop reaches out to external systems on a schedule -- nothing reaches in.

- **Zero inbound attack surface.** No open ports, no public endpoints.
- **No webhook secrets to rotate** or signature validation to get wrong.
- **No auth tokens exposed** on your infrastructure.
- **Works behind NAT, firewalls, VPNs** with zero configuration.

```yaml
# Outbound polling, no inbound surface
sources:
  - id: github
    connector: "@orgloop/connector-github"
    config:
      repo: "my-org/my-repo"
      poll_interval: 5m
      token: "${GITHUB_TOKEN}"
```

Your organization reaches out. Nothing reaches in.

## Transform-based injection defense

Events from external sources can contain adversarial content -- a GitHub comment with "ignore previous instructions," a Linear ticket with embedded authority claims. OrgLoop's answer: **transforms intercept events before they ever reach an actor**.

```yaml
routes:
  - name: github-to-engineering
    when:
      source: github
      events: [resource.changed]
    transforms:
      - ref: drop-bot-noise
      - ref: dedup
    then:
      actor: openclaw-engineering-agent
```

Today, the built-in transforms handle filtering and deduplication. You can write custom script transforms that inspect payloads for injection patterns -- a shell script that reads event JSON from stdin, checks for suspicious content, and exits with code 1 to drop the event. The transform pipeline is the right place for this because it runs before events reach any actor.

This is defense-in-depth: actors should still handle adversarial input, but the transport layer can filter obvious attacks before they arrive.

## Input validation

All configuration is validated against JSON Schema via AJV. `orgloop validate` enforces schemas **before runtime**:

```
$ orgloop validate

  ✓ connectors/github.yaml — valid source definition
  ✓ connectors/openclaw.yaml — valid actor definition
  ✗ routes/engineering.yaml — error at routes[0].transforms[1]:
      Transform "my-filter" not found.

  1 error, 0 warnings
```

At runtime, malformed events are rejected at ingestion -- not when they reach an actor. Schema enforcement catches missing required fields, unexpected event types, malformed payloads, and reference integrity violations (routes pointing to nonexistent sources or actors).

## Least-privilege routing

Actors only see events their routes explicitly match. There is no broadcast bus, no "subscribe to everything." Routes are **allow-lists**, not deny-lists.

- The engineering agent sees GitHub and Linear events -- nothing else.
- The on-call actor sees PagerDuty alerts -- not code reviews.
- A compromised actor cannot eavesdrop on events it was never routed.

Every route is a deliberate, auditable decision about who sees what.

## Secrets management

Connector configs support `${ENV_VAR}` substitution. Secrets never live in YAML:

```yaml
config:
  token: "${GITHUB_TOKEN}"           # GitHub
  api_key: "${LINEAR_API_KEY}"       # Linear
  bot_token: "${SLACK_BOT_TOKEN}"    # Slack
```

In practice:
- **Local development:** `.env` file (git-ignored)
- **Production:** platform secret stores (1Password CLI, AWS Secrets Manager, Vault)
- **CI:** injected via environment

OrgLoop never logs resolved secret values. `orgloop validate` checks that referenced environment variables exist without printing them.

## Audit trail by default

Loggers are **first-class primitives** in OrgLoop, not optional add-ons. Every event, every routing decision, every transform result, every delivery is logged with trace IDs:

```jsonl
{"ts":"...","phase":"source.emit","source":"github","event_id":"evt_abc","event_type":"resource.changed"}
{"ts":"...","phase":"transform.pass","transform":"drop-bot-noise","event_id":"evt_abc","result":"pass"}
{"ts":"...","phase":"route.match","event_id":"evt_abc","matched":"github-to-engineering"}
{"ts":"...","phase":"deliver.success","event_id":"evt_abc","target":"openclaw-engineering-agent","status":"delivered"}
```

You get a complete, queryable trail of what happened, why it was routed that way, and what the system did about it. Dropped events are logged with the reason. Transform mutations are logged with before/after diffs.

```bash
# Trace a specific event end-to-end
orgloop logs --event evt_abc123

# Show all dropped events in the last hour
orgloop logs --result drop --since 1h
```

See the [Building Transforms](/guides/transform-authoring/) guide for details on how transforms interact with the audit pipeline.

## Plan before start

`orgloop plan` shows exactly what will change before any config is applied:

```
$ orgloop plan

  Sources:
    + github          (new — poll every 5m)
    ~ claude-code     (changed — hook_type: post-exit → exit)

  Transforms:
    + drop-bot-noise     (new — package)

  Routes:
    + github-to-engineering  (new)

  Plan: 3 to add, 1 to change, 0 to remove.
  Run `orgloop start` to execute this plan.
```

No surprise mutations. You review the diff, then start. Infrastructure-as-code discipline applied to your organization's operational topology.

## Supply chain security

Connectors are **npm packages** -- auditable source code, not opaque marketplace plugins.

- `@orgloop/*` -- first-party connectors, maintained by the OrgLoop team
- Community connectors -- published on npm, standard review applies
- `npm audit` for vulnerability scanning
- `package-lock.json` for deterministic installs
- Full source code inspection before you trust a connector with your event stream

No walled-garden marketplace, no binary blobs.

## Network posture

OrgLoop's default network posture is **zero inbound connections**:

- Sources poll outbound -- no listening ports
- `orgloop start` runs as a local daemon with no network exposure
- `orgloop serve` (HTTP API) is opt-in and binds to `127.0.0.1` by default

For production deployments:
- Run behind Tailscale, WireGuard, or your VPN of choice
- If `orgloop serve` is needed, bind explicitly with `--host 0.0.0.0` -- this requires a conscious decision
- Webhook ingestion (for push-based sources like Claude Code hooks) binds to localhost by default
