---
title: "Example: Beyond Engineering"
description: OrgLoop encodes any organization — support, sales, DevOps, legal, HR, finance, marketing. Same primitives, different connectors.
---

import { Aside } from '@astrojs/starlight/components';

The [engineering org](/examples/engineering-org/) example shows OrgLoop managing a software team. But OrgLoop's five primitives -- sources, actors, routes, transforms, loggers -- encode *any* organizational structure. Every department follows the same shape: events arrive from domain-specific systems, routes match them, actors do work, completions feed back.

This page shows how that shape maps across domains. The architecture is identical. Only the connectors change.

## The universal shape

Every department is:

```
Domain system (poll/hook) --> route (filter by event type) --> agent (with domain SOP)
                                                                  |
                                                           actor.stopped --> next step
```

Customer support, DevOps, sales, legal -- they all follow this. The connectors are different. The routing logic is different. The SOPs are different. But the *architecture* is the same five primitives.

## Domain examples

<Aside type="note">
These examples reference connectors that aren't built yet. The architecture is sound -- each planned connector follows the same `SourceConnector` or `ActorConnector` interface as existing ones. Building them is implementation work, not design work. Each is a contribution opportunity.
</Aside>

### Customer support

Tickets arrive from a helpdesk. An L1 agent triages. If the issue needs engineering, its `actor.stopped` event routes to an engineering agent. Resolution routes back to support for customer notification.

```yaml
sources:
  - id: helpdesk
    connector: "@orgloop/connector-zendesk"  # planned
    config:
      subdomain: "${ZENDESK_SUBDOMAIN}"
      token: "${ZENDESK_TOKEN}"
    poll: { interval: 2m }

actors:
  - id: support-l1
    connector: "@orgloop/connector-openclaw"
    config:
      agent_id: support-l1
      auth_token_env: "${OPENCLAW_WEBHOOK_TOKEN}"

routes:
  - name: new-ticket
    when: { source: helpdesk, events: [resource.changed] }
    then: { actor: support-l1 }
    with: { prompt_file: "./sops/triage-ticket.md" }
```

**Connectors needed:** `@orgloop/connector-zendesk` (planned). Actor uses existing `@orgloop/connector-openclaw`.

### DevOps / incident response

Monitoring alerts route to an incident responder. The responder's completion triggers a post-incident review.

```yaml
sources:
  - id: monitoring
    connector: "@orgloop/connector-pagerduty"  # planned
    config:
      api_key: "${PAGERDUTY_API_KEY}"
    poll: { interval: 1m }

routes:
  - name: alert-triage
    when: { source: monitoring, events: [resource.changed] }
    transforms: [dedup-alerts]
    then: { actor: incident-responder }
    with: { prompt_file: "./sops/incident-response.md" }

  - name: post-incident
    when: { source: incident-responder, events: [actor.stopped] }
    then: { actor: post-incident-reviewer }
    with: { prompt_file: "./sops/post-incident-review.md" }
```

**Connectors needed:** `@orgloop/connector-pagerduty` (planned). Could also use `@orgloop/connector-webhook` with a PagerDuty webhook today.

### Sales

CRM events (new lead, deal stage change) route to specialized agents by deal stage.

```yaml
sources:
  - id: crm
    connector: "@orgloop/connector-salesforce"  # planned
    config:
      instance_url: "${SALESFORCE_URL}"
      token: "${SALESFORCE_TOKEN}"
    poll: { interval: 5m }

routes:
  - name: new-lead
    when:
      source: crm
      events: [resource.changed]
      filter: { provenance.platform_event: "lead.created" }
    then: { actor: lead-researcher }
    with: { prompt_file: "./sops/research-lead.md" }

  - name: deal-closed
    when:
      source: crm
      events: [resource.changed]
      filter: { provenance.platform_event: "opportunity.closed_won" }
    then: { actor: onboarding-agent }
    with: { prompt_file: "./sops/client-onboarding.md" }
```

**Connectors needed:** `@orgloop/connector-salesforce` (planned).

### Legal and compliance

Document signing events trigger contract review. A compliance auditor runs on a weekly schedule.

```yaml
sources:
  - id: contracts
    connector: "@orgloop/connector-webhook"  # available today
    config:
      path: /webhook/contracts
      hmac_secret: "${CONTRACT_HMAC_SECRET}"

  - id: weekly-audit
    connector: "@orgloop/connector-cron"  # available today
    config:
      schedule: "0 6 * * 1"

routes:
  - name: contract-review
    when: { source: contracts, events: [resource.changed] }
    then: { actor: contract-reviewer }
    with: { prompt_file: "./sops/review-contract.md" }

  - name: compliance-audit
    when: { source: weekly-audit, events: [resource.changed] }
    then: { actor: compliance-auditor }
    with: { prompt_file: "./sops/weekly-compliance.md" }
```

**Connectors needed:** None -- uses `@orgloop/connector-webhook` and `@orgloop/connector-cron`, both available today.

## The full picture

| Department | Source connector | Events | Actor purpose |
|-----------|-----------------|--------|---------------|
| Engineering | GitHub, Linear, Claude Code | PRs, issues, session completions | Code review, CI triage, supervision |
| Customer Support | Zendesk, Intercom | Tickets, messages | Triage, resolution, escalation |
| DevOps / SRE | PagerDuty, Datadog | Alerts, incidents | Incident response, post-mortem |
| Sales | Salesforce, HubSpot | Leads, deals, stage changes | Research, proposals, follow-up |
| Legal | Webhook, DocuSign | Contracts, filings | Review, compliance audit |
| Finance | QuickBooks, Stripe | Invoices, payments | Processing, reconciliation |
| HR | Workday, Greenhouse | Hires, terminations | Onboarding, offboarding |
| Marketing | Mailchimp, Analytics | Campaigns, metrics | Analysis, content generation |
| Communications | Twilio, SendGrid | Calls, emails, messages | Routing to appropriate handlers |

Every row is the same architecture. The connectors are different. The SOPs are different. The routing rules are different. But the shape -- source, route, transform, actor, loop -- is always OrgLoop's five primitives.

## What this means

OrgLoop is not an engineering tool. It is an organizational tool. The engineering connectors were built first because that is where it was born. But the architecture encodes any process where:

1. Events arrive from external systems
2. They need to be routed to the right handler
3. The handler's completion may trigger the next step

That is every department. That is every organization.

As connectors are built for more domains, the same `orgloop.yaml` that runs your engineering team can run your entire company. Each department is a project with its own connectors, routes, and SOPs. Projects compose. The [org-to-org example](/examples/org-to-org/) takes this one step further.
