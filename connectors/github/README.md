# @orgloop/connector-github

Polls the GitHub REST API for pull request, issue, and CI activity on a repository.

## Install

```bash
npm install @orgloop/connector-github
```

## Configuration

```yaml
sources:
  - id: github-eng
    connector: "@orgloop/connector-github"
    config:
      repo: "my-org/my-repo"          # owner/repo to watch
      token: "${GITHUB_TOKEN}"         # PAT or fine-grained token (env var ref)
      events:                          # which event types to poll
        - pull_request.review_submitted
        - pull_request_review_comment
        - issue_comment
        - pull_request.opened
        - pull_request.closed
        - pull_request.merged
        - pull_request.ready_for_review
        - workflow_run.completed
        - check_suite.completed
      authors:                         # optional — only include events by these users
        - alice
        - bob
    poll:
      interval: "5m"
```

### Config options

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repo` | `string` | yes | GitHub repository in `owner/repo` format |
| `token` | `string` | yes | GitHub PAT. Supports `${ENV_VAR}` syntax |
| `events` | `string[]` | yes | Event types to poll (see below) |
| `authors` | `string[]` | no | Filter to events authored by these GitHub logins |

## Events emitted

All events are emitted as OrgLoop `resource.changed` type.

### Supported event types

| Event string | What it polls | OrgLoop type |
|---|---|---|
| `pull_request.review_submitted` | PR reviews (approve, request changes, comment) | `resource.changed` |
| `pull_request_review_comment` | Inline review comments on PRs | `resource.changed` |
| `issue_comment` | Comments on issues and PRs | `resource.changed` |
| `pull_request.opened` | Newly created PRs | `resource.changed` |
| `pull_request.closed` | Closed PRs | `resource.changed` |
| `pull_request.merged` | Merged PRs (polled via closed PRs) | `resource.changed` |
| `pull_request.ready_for_review` | Draft PRs marked ready for review | `resource.changed` |
| `workflow_run.completed` | Failed GitHub Actions workflow runs | `resource.changed` |
| `check_suite.completed` | Completed check suites | `resource.changed` |

### Example event payload (PR review)

```json
{
  "id": "evt_a1b2c3d4e5f67890",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "source": "github:my-org/my-repo",
  "type": "resource.changed",
  "provenance": {
    "platform": "github",
    "platform_event": "pull_request.review_submitted",
    "author": "alice",
    "author_type": "team_member",
    "repo": "my-org/my-repo",
    "pr_number": 42,
    "url": "https://github.com/my-org/my-repo/pull/42#pullrequestreview-123",
    "review_state": "approved"
  },
  "payload": {
    "action": "review_submitted",
    "review_state": "approved",
    "review_body": "LGTM!",
    "pr_title": "Add feature X",
    "pr_number": 42
  }
}
```

## Example route

```yaml
routes:
  - name: pr-review-to-openclaw
    when:
      source: github-eng
      events:
        - resource.changed
      filter:
        provenance.platform_event: pull_request.review_submitted
    then:
      actor: openclaw-agent
```

## Auth / prerequisites

- A GitHub Personal Access Token (classic or fine-grained) with read access to the target repository.
- For fine-grained tokens, the following permissions are needed:
  - **Pull requests**: Read
  - **Issues**: Read
  - **Actions**: Read (for `workflow_run.completed`)
- Set the token as an environment variable (e.g., `GITHUB_TOKEN`) and reference it in the config with `${GITHUB_TOKEN}`.

## Limitations / known issues

- **Polling only** -- this connector uses the GitHub REST API, not webhooks. Events may be delayed up to one poll interval.
- **Rate limits** -- GitHub API rate limits apply (5,000 requests/hour for authenticated requests). The connector backs off gracefully on 429 responses but high-frequency polling of repos with many open PRs can consume quota quickly.
- **Per-page limits** -- Review polling fetches up to 30 recently updated PRs and their reviews. Very active repos may miss reviews on older PRs.
- **Bot detection** -- Authors with `[bot]` suffix or GitHub `type: "Bot"` are classified as `author_type: "bot"`.
- **No webhook receiver** -- Unlike `connector-webhook`, this connector has no webhook handler; it only polls.
