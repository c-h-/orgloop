---
title: "Example: Org-to-Org"
description: Two OrgLoop instances communicating through webhooks — organizations as protocol endpoints.
---

import { Aside } from '@astrojs/starlight/components';

<Aside type="note">
This example uses only `@orgloop/connector-webhook` (available today) and `@orgloop/connector-cron` (available today). The architecture works with current connectors.
</Aside>

What happens when two organizations both run OrgLoop? They can communicate through webhooks -- one org's actor delivers to another org's source. Organizations become protocol endpoints.

This is the natural endpoint of the project model. A department is a project with its own connectors, routes, and SOPs. An organization is a composition of projects. Org-to-org communication is just another route.

## Architecture

```
Organization A                              Organization B
─────────────                              ─────────────
                                           webhook source
actor (sends request) ──── HTTP POST ────> /webhook/partner
       |                                        |
       |                                     route
       |                                        |
       |                                  actor (processes)
       |                                        |
       |                                  actor.stopped
       |                                        |
       |                                  actor (sends response)
       |                                        |
webhook source  <──── HTTP POST ──────── delivers via webhook target
/webhook/partner
       |
    route
       |
  actor (processes response)
```

Two OrgLoop instances. Each exposes a webhook source. Each has a webhook target pointed at the other's source. Events flow between them as HTTP POSTs. Each org processes incoming events through its own routes, transforms, and actors -- fully independent, fully auditable.

## YAML: Organization A (client)

```yaml
apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: acme-corp
  description: "Client organization"

sources:
  # Internal trigger -- could be cron, GitHub, or any source
  - id: procurement-schedule
    connector: "@orgloop/connector-cron"
    config:
      schedule: "0 9 * * 1"  # Monday 9am
    emits: [resource.changed]

  # Receive responses from partner
  - id: partner-responses
    connector: "@orgloop/connector-webhook"
    config:
      path: /webhook/partner
      hmac_secret: "${PARTNER_HMAC_SECRET}"

actors:
  # Send requests to partner org
  - id: partner-requester
    connector: "@orgloop/connector-webhook"
    config:
      url: "https://partner-org.example.com/webhook/client"
      hmac_secret: "${PARTNER_HMAC_SECRET}"
      method: POST

  # Process partner responses
  - id: response-processor
    connector: "@orgloop/connector-openclaw"
    config:
      agent_id: procurement
      auth_token_env: "${OPENCLAW_WEBHOOK_TOKEN}"

routes:
  - name: weekly-order
    description: "Monday schedule -> Send purchase order to partner"
    when: { source: procurement-schedule, events: [resource.changed] }
    then: { actor: partner-requester }
    with: { prompt_file: "./sops/generate-purchase-order.md" }

  - name: process-confirmation
    description: "Partner confirms order -> Process confirmation"
    when: { source: partner-responses, events: [resource.changed] }
    then: { actor: response-processor }
    with: { prompt_file: "./sops/process-order-confirmation.md" }

loggers:
  - name: partner-audit
    type: "@orgloop/logger-file"
    config:
      path: ./logs/partner-comms.log
      format: jsonl
```

## YAML: Organization B (supplier)

```yaml
apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: supplier-inc
  description: "Supplier organization"

sources:
  # Receive requests from client
  - id: client-requests
    connector: "@orgloop/connector-webhook"
    config:
      path: /webhook/client
      hmac_secret: "${CLIENT_HMAC_SECRET}"

actors:
  # Process incoming orders
  - id: order-processor
    connector: "@orgloop/connector-openclaw"
    config:
      agent_id: fulfillment
      auth_token_env: "${OPENCLAW_WEBHOOK_TOKEN}"

  # Send confirmations back to client
  - id: client-responder
    connector: "@orgloop/connector-webhook"
    config:
      url: "https://acme-corp.example.com/webhook/partner"
      hmac_secret: "${CLIENT_HMAC_SECRET}"
      method: POST

routes:
  - name: process-order
    description: "Client sends order -> Process and validate"
    when: { source: client-requests, events: [resource.changed] }
    then: { actor: order-processor }
    with: { prompt_file: "./sops/process-incoming-order.md" }

  - name: send-confirmation
    description: "Order processed -> Confirm back to client"
    when: { source: order-processor, events: [actor.stopped] }
    then: { actor: client-responder }

loggers:
  - name: client-audit
    type: "@orgloop/logger-file"
    config:
      path: ./logs/client-comms.log
      format: jsonl
```

## What makes this work

**No special protocol.** Org-to-org communication uses the same webhook connector that handles any HTTP integration. One org's webhook target POSTs to another org's webhook source. Standard HTTP. Standard HMAC authentication. Standard OrgLoop routing on both sides.

**Full independence.** Each organization runs its own OrgLoop instance with its own config, its own routes, its own transforms, its own logs. Neither org needs to know or trust the other's internal structure. They agree on a webhook endpoint and an HMAC secret. That's the entire contract.

**Full auditability.** Both sides log every event. The file logger captures every inbound request, every routing decision, every delivery. If there's a dispute about what was sent or received, the audit trail is complete on both sides.

**Composable with everything else.** The org-to-org route is just another route. It composes with department projects, supervisor loops, transforms, and any other OrgLoop feature. A support department can escalate to an external vendor's OrgLoop instance the same way it escalates to an internal engineering team -- the route structure is identical.

## Variations

### Multi-partner hub

One organization communicates with many partners. Each partner gets its own webhook path and HMAC secret:

```yaml
sources:
  - id: partner-alpha
    connector: "@orgloop/connector-webhook"
    config: { path: /webhook/alpha, hmac_secret: "${ALPHA_SECRET}" }

  - id: partner-beta
    connector: "@orgloop/connector-webhook"
    config: { path: /webhook/beta, hmac_secret: "${BETA_SECRET}" }

routes:
  - name: alpha-requests
    when: { source: partner-alpha, events: [resource.changed] }
    then: { actor: alpha-handler }

  - name: beta-requests
    when: { source: partner-beta, events: [resource.changed] }
    then: { actor: beta-handler }
```

### Bidirectional service mesh

Multiple organizations, each exposing services to each other. OrgLoop on each node. Webhook routes between them. This is a service mesh where the services are entire organizations.

```
   Org A ←──webhook──→ Org B
     ↑                   ↑
     |                   |
  webhook             webhook
     |                   |
     v                   v
   Org C ←──webhook──→ Org D
```

Each org maintains its own routes, transforms, and SOPs. The mesh is just webhook connections. No central coordinator. No shared state. Each org is sovereign.

## Why this matters

Human organizations communicate through protocols: email, phone, contracts, invoices. Each organization processes inbound communications through its own internal routing. A purchase order arrives, gets routed to the right department, gets processed, and a confirmation goes back.

OrgLoop makes this explicit. An organization's communication interface is a set of webhook endpoints. Its internal routing is a set of routes and transforms. Its processing capacity is a set of actors with SOPs.

When both sides of a business relationship run OrgLoop, the entire interaction -- from initial request through processing to confirmation -- is declarative, auditable, and autonomous. The organizations loop, independently and together.
