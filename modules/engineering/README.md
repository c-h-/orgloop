# @orgloop/module-engineering

Engineering organization workflow module for OrgLoop. Wires GitHub, Linear, and Claude Code into a supervised loop through an OpenClaw agent — PR reviews get addressed, CI failures get fixed, tickets get triaged, and Claude Code sessions get evaluated and relaunched when they finish.

5 routes, 4 SOPs, and 3 transforms. Install it, configure your connectors, and the engineering loop runs.

## Install

```bash
orgloop add module @orgloop/module-engineering
```

## What You Get

### Routes

| Route | Trigger | What Happens |
|-------|---------|-------------|
| **pr-review** | PR review submitted | Agent wakes with PR review SOP — reads comments, makes fixes, pushes, re-requests review |
| **pr-comment** | Inline PR comment | Same SOP — addresses the specific comment in context |
| **ci-failure** | CI workflow fails | Agent wakes with CI failure SOP — diagnoses the failure, fixes root cause, pushes |
| **linear-triage** | Linear issue updated | Agent wakes with triage SOP — evaluates the ticket, decides action based on state change |
| **claude-code-supervisor** | Claude Code session ends | Agent evaluates what the dev session accomplished — relaunches, opens PR, or escalates |

### The Loop in Action

This is where it clicks. The routes aren't independent — they form a loop:

```
Linear ticket assigned
  → linear-triage route wakes agent → agent starts Claude Code implementation
    → Claude Code finishes → claude-code-supervisor route wakes agent
      → agent evaluates output → opens PR
        → PR gets review → pr-review route wakes agent
          → agent addresses feedback → pushes → CI runs
            → CI fails → ci-failure route wakes agent
              → agent fixes → CI passes → ready for merge
```

Each step triggers the next. The org loops.

### SOPs (Standard Operating Procedures)

Each route delivers a focused SOP — the agent gets specific instructions for exactly what happened, not a grab-bag of everything it might need to know.

- **`pr-review.md`** — Parse the review, address each comment individually, check PR health before re-requesting review. Includes guidance on AI/bot comments and security red flags.
- **`ci-failure.md`** — Categorize the failure (type errors, lint, tests, build, flaky), fix root cause, verify CI passes. Never skip or disable tests.
- **`linear-ticket.md`** — Triage before acting: is it clear? Is it blocked? Is someone already on it? Action table by state change.
- **`claude-code-supervisor.md`** — Evaluate session output, decide whether to relaunch, open PR, or escalate. Guards against infinite relaunch loops.

### Transforms

- **drop-bot-noise** — Filters out events authored by bots (you don't need to review your own bot's actions)
- **my-notifications** — Keeps only events involving your watched GitHub accounts (`GITHUB_WATCHED`)
- **dedup** — Deduplicates events within a 10-minute window (GitHub often sends multiple events for the same action)

## Prerequisites

- **GitHub** — repo access + [personal access token](https://github.com/settings/tokens) with `repo` scope
- **OpenClaw** — running locally with a webhook token configured
- **Linear** *(optional)* — API key for ticket management. Module works without it; Linear routes are skipped.
- **Claude Code** *(optional)* — installed locally for the supervisor loop. Module works without it; supervisor route is skipped.

Run `orgloop doctor` after installing — it checks every dependency and tells you exactly what's missing and how to get it.

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `github_source` | yes | `github` | Name of your GitHub source connector |
| `linear_source` | no | `linear` | Name of your Linear source connector |
| `claude_code_source` | no | `claude-code` | Name of your Claude Code source connector |
| `agent_actor` | yes | `openclaw-engineering-agent` | Name of your agent actor |

## Required Credentials

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | yes | GitHub personal access token (repo scope) |
| `GITHUB_REPO` | yes | GitHub repository (owner/repo) |
| `GITHUB_WATCHED` | yes | Comma-separated GitHub usernames to watch |
| `OPENCLAW_WEBHOOK_TOKEN` | yes | OpenClaw webhook authentication token |
| `OPENCLAW_AGENT_ID` | yes | OpenClaw agent ID |
| `LINEAR_API_KEY` | no | Linear API key |
| `LINEAR_TEAM_KEY` | no | Linear team key |

## Customizing

The SOPs are starting points. Copy them to your project's `sops/` directory and customize:

```bash
cp node_modules/@orgloop/module-engineering/sops/*.md ./sops/
```

Then update your routes to point at your local copies. Make the SOPs match how your team actually works — add your review standards, your CI conventions, your triage criteria.

## Documentation

Full documentation at [orgloop.ai](https://orgloop.ai). See the [Manifesto](https://orgloop.ai/vision/manifesto/) for the thinking behind Organization as Code.

## License

MIT
