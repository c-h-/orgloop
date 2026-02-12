---
title: "Example: GitHub to Slack"
description: Single source, single actor — GitHub PR events to Slack notifications.
---

import { Aside } from '@astrojs/starlight/components';

<Aside type="note" title="Prerequisites: 2 tokens">
This example requires a **GitHub personal access token** and a **Slack incoming webhook URL**. If you do not have these yet, see the setup instructions below -- each takes about 1 minute to create.
</Aside>

The simplest real-world OrgLoop setup: one GitHub source, one Slack webhook actor, one route. About 5 minutes from clone to running (including token setup).

## What this example shows

- A single-file config with source, actor, route, and logger all in one `orgloop.yaml`
- Poll-based GitHub source with event type filtering
- Generic webhook actor for Slack delivery
- The minimal wiring to get events flowing

## Prerequisites

- Node.js >= 22
- OrgLoop CLI installed (`npm install -g @orgloop/cli`)
- A GitHub personal access token with `repo` read access
- A Slack incoming webhook URL

## Setup (~5 minutes)

### 1. Get your tokens

- **GitHub**: Create a [personal access token](https://github.com/settings/tokens) with `repo` read access
- **Slack**: Create an [incoming webhook](https://api.slack.com/messaging/webhooks) for your target channel

### 2. Set environment variables

```bash
export GITHUB_REPO="your-org/your-repo"
export GITHUB_TOKEN="ghp_..."
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/T.../B.../..."
```

### 3. Run

```bash
cd examples/github-to-slack
orgloop validate
orgloop start
```

PR reviews on your repo now show up in Slack.

## The config

Everything in one file:

### `orgloop.yaml`

```yaml
# orgloop.yaml — GitHub to Slack
# Single source, single actor, one route. Simplest real-world setup.

apiVersion: orgloop/v1alpha1
kind: Project
metadata:
  name: github-to-slack
  description: "GitHub PR notifications to Slack"

defaults:
  poll_interval: 5m
  log_level: info

# ─── Source ──────────────────────────────────────────────────────────────────

sources:
  - id: github
    description: GitHub PR activity
    connector: "@orgloop/connector-github"
    config:
      repo: "${GITHUB_REPO}"
      token: "${GITHUB_TOKEN}"
      events:
        - "pull_request.review_submitted"
        - "pull_request_review_comment"
        - "issue_comment"
    poll:
      interval: 5m
    emits:
      - resource.changed

# ─── Actor ───────────────────────────────────────────────────────────────────

actors:
  - id: slack-notify
    description: Slack incoming webhook
    connector: "@orgloop/connector-webhook"
    config:
      url: "${SLACK_WEBHOOK_URL}"
      method: POST

# ─── Route ───────────────────────────────────────────────────────────────────

routes:
  - name: github-to-slack
    description: "GitHub PR activity -> Slack notification"
    when:
      source: github
      events:
        - resource.changed
    then:
      actor: slack-notify

# ─── Logger ──────────────────────────────────────────────────────────────────

loggers:
  - name: console-log
    type: "@orgloop/logger-console"
    config:
      level: info
      color: true
```

## Environment variables

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `GITHUB_REPO` | Repository in `owner/repo` format | Your GitHub repo URL |
| `GITHUB_TOKEN` | Personal access token with repo read access | [GitHub Settings](https://github.com/settings/tokens) |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL | [Slack API](https://api.slack.com/messaging/webhooks) |

## How it works

```
GitHub (poll every 5m)
  |
  v
resource.changed (PR review, comment)
  |
  v
Route: github-to-slack (matches source: github, events: resource.changed)
  |
  v
Slack webhook (POST to SLACK_WEBHOOK_URL)
```

The GitHub connector polls your repository every 5 minutes for new PR reviews, review comments, and issue comments. Each event becomes a `resource.changed` event on the bus. The single route matches all `resource.changed` events from the `github` source and delivers them to the `slack-notify` actor, which POSTs to your Slack webhook URL.

## How to test

Submit a review on a PR in your configured repository. Within 5 minutes (the poll interval), you should see a notification in your Slack channel and a log line in the console:

```
[info] event.delivered   github  resource.changed  slack-notify  evt_abc123
```

To test immediately without waiting for a real PR event, reduce the poll interval to `30s` during development.

## Customization

- **More event types**: Add entries to `config.events` (e.g., `workflow_run.completed` for CI failures, `pull_request.merged` for merge notifications)
- **Filter events**: Add a `filter` clause to the route to narrow which events reach Slack (e.g., only reviews on a specific branch)
- **Add transforms**: Insert a `transforms` block in the route to filter bot noise or deduplicate events before delivery
- **Multiple channels**: Add more actors and routes to send different event types to different Slack channels
