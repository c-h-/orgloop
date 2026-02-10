# @orgloop/module-engineering

Engineering organization workflow module -- PR review, CI failure triage, Linear ticket management, and Claude Code supervision. Wires GitHub, Linear, and Claude Code sources to an OpenClaw agent actor.

## Install

```bash
orgloop add module engineering
```

## What's Included

**Sources (3):**
- **github** -- GitHub repository events (PR reviews, comments, CI failures, merges)
- **linear** -- Linear project tracking events (optional, skipped if unconfigured)
- **claude-code** -- Claude Code session exit events (optional, skipped if unconfigured)

**Actors (1):**
- **openclaw-engineering-agent** -- OpenClaw agent for executing engineering workflows

**Routes (5):**
- **pr-review** -- PR review submitted: address feedback
- **pr-comment** -- PR review comment: respond to inline feedback
- **ci-failure** -- CI workflow failed: diagnose and fix
- **linear-triage** -- Linear issue updated: triage and act
- **claude-code-supervisor** -- Claude Code session ended: review and decide next action

**Transforms (3):**
- **drop-bot-noise** -- Filter out events authored by bots
- **my-notifications** -- Keep only events involving watched GitHub accounts (`GITHUB_WATCHED`)
- **dedup** -- Deduplicate events within a 10-minute window

**SOPs (3):** `pr-review.md`, `ci-failure.md`, `linear-ticket.md`

**Loggers (1):** File logger writing JSONL to `~/.orgloop/logs/orgloop.log`

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

## Documentation

Full documentation at [orgloop.ai](https://orgloop.ai)

## License

MIT
