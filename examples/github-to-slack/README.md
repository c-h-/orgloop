# GitHub to Slack Example

Single GitHub source, single Slack webhook actor, one route. The simplest real-world OrgLoop setup.

## What it does

- Polls a GitHub repository for PR reviews and comments
- Sends notifications to a Slack channel via incoming webhook

## Prerequisites

- Node.js >= 22
- OrgLoop CLI installed (`npm install -g @orgloop/cli`)
- A [GitHub personal access token](https://github.com/settings/tokens) with `repo` read access
- A [Slack incoming webhook URL](https://api.slack.com/messaging/webhooks)

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

That's it. PR reviews on your repo now show up in Slack.

## Files

```
orgloop.yaml          # Everything in one file: source, actor, route, logger
```

## How it works

```
GitHub (poll every 5m)
  |
  v
resource.changed (PR review)
  |
  v
Route: github-to-slack
  |
  v
Slack webhook (POST)
```

## Customization

- Change `poll.interval` to adjust how frequently GitHub is polled
- Add more event types under `config.events` (e.g., `workflow_run.completed` for CI failures)
- Add a `filter` to the route to narrow which events reach Slack
