---
title: Patterns & Recipes
description: Common automation patterns implemented with existing OrgLoop primitives. No new code needed.
---

OrgLoop's five primitives — sources, actors, routes, transforms, loggers — compose into surprisingly powerful patterns. This page shows how to solve common needs using what already exists, so you reach for the right tool instead of adding surface area.

Every recipe below uses standard YAML config and built-in transforms. No custom code required unless stated otherwise.

## Filtering by array fields (labels, assignees)

**Problem:** You want to route events only when a PR has a specific label, or when an issue is assigned to someone on your team.

**Solution:** Use the [transform-filter](/guides/transform-filter/) in jq mode. The `any` function is your friend for arrays.

```yaml
# Only events where the PR has the "needs-review" label
transforms:
  - name: has-needs-review-label
    type: package
    package: "@orgloop/transform-filter"
    config:
      jq: '.payload.labels | any(.name == "needs-review")'
```

```yaml
# Only events where the assignee is on the platform team
transforms:
  - name: platform-team-only
    type: package
    package: "@orgloop/transform-filter"
    config:
      jq: '.payload.assignees | any(.login == "alice" or .login == "bob")'
```

Why jq? The basic `match`/`exclude` modes use dot-path field matching — great for scalar fields, but they can't inspect array elements. jq gives you full query power over nested structures. See the [transform-filter deep dive](/guides/transform-filter/) for the full capability breakdown.

## Ownership-based filtering (only my PRs)

**Problem:** You only want events related to PRs you authored, or that a specific bot created.

**Solution:** Use `match_any` with comma-separated authors, or jq for complex ownership logic.

### Simple: match by PR author

```yaml
transforms:
  - name: my-prs-only
    type: package
    package: "@orgloop/transform-filter"
    config:
      match_any:
        provenance.pr_author: "alice,bob"  # Comma-separated = OR matching
```

The filter automatically expands comma-separated values to arrays, so `"alice,bob"` means "alice OR bob". This is especially useful with environment variables:

```yaml
config:
  match_any:
    provenance.pr_author: "${MY_GITHUB_USERNAMES}"  # Set MY_GITHUB_USERNAMES=alice,bot-alice
```

### Complex: combine author + org membership

```yaml
transforms:
  - name: team-ownership
    type: package
    package: "@orgloop/transform-filter"
    config:
      jq: >
        .provenance.pr_author == "alice" or
        .provenance.pr_author == "bob" or
        (.payload.labels | any(.name == "team-platform"))
```

## Multi-agent routing (different SOPs per event type)

**Problem:** Different event types need different agent behaviors. PR reviews need a code review SOP, CI failures need a debugging SOP, new tickets need a triage SOP.

**Solution:** This is what routes are for. Define multiple routes from the same source, each with a different `when.filter` and `with.prompt_file`.

```yaml
routes:
  # PR reviews → code review agent with review SOP
  - name: pr-review
    when:
      source: github
      events: [resource.changed]
      filter:
        provenance.platform_event: pull_request.review_submitted
    then:
      actor: engineering-agent
    with:
      prompt_file: ./sops/pr-review.md

  # CI failures → same agent, different SOP
  - name: ci-failure
    when:
      source: github
      events: [resource.changed]
      filter:
        provenance.platform_event: workflow_run.completed
    transforms:
      - ref: ci-failure-filter  # Only failed runs
    then:
      actor: engineering-agent
    with:
      prompt_file: ./sops/ci-failure.md

  # Linear tickets → triage agent
  - name: new-ticket
    when:
      source: linear
      events: [resource.changed]
    then:
      actor: triage-agent
    with:
      prompt_file: ./sops/triage.md
```

Key insight: the route's `when.filter` does coarse routing (event type, platform event), while transforms do fine-grained filtering (author, labels, priority). Use both together:

```yaml
# Route filter: only PR review events from GitHub
when:
  source: github
  events: [resource.changed]
  filter:
    provenance.platform_event: pull_request.review_submitted

# Transform filter: only from team members, excluding bots
transforms:
  - ref: team-members-only
  - ref: drop-bot-noise
```

Route filters run before the transform pipeline, so they're more efficient for coarse decisions. See [Config Schema — Route Definition](/reference/config-schema/#route-definition) for the full `when.filter` reference.

## One event, multiple actors

**Problem:** A single event should trigger work from multiple actors — e.g., a PR merge should notify Slack AND update a dashboard AND trigger a deploy review.

**Solution:** Define multiple routes matching the same event. Each route delivers to a different actor independently.

```yaml
routes:
  - name: pr-merge-notify
    when:
      source: github
      events: [resource.changed]
      filter:
        provenance.platform_event: pull_request.merged
    then:
      actor: slack-notifier

  - name: pr-merge-dashboard
    when:
      source: github
      events: [resource.changed]
      filter:
        provenance.platform_event: pull_request.merged
    then:
      actor: dashboard-updater

  - name: pr-merge-deploy-review
    when:
      source: github
      events: [resource.changed]
      filter:
        provenance.platform_event: pull_request.merged
    transforms:
      - ref: production-branch-only
    then:
      actor: deploy-reviewer
    with:
      prompt_file: ./sops/deploy-review.md
```

OrgLoop evaluates all routes for every event. One event can match multiple routes and be delivered to multiple actors. Each route's transform pipeline runs independently.

## Deduplication patterns

**Problem:** The same event keeps arriving — GitHub sends the same PR data on every poll, or a webhook fires twice for the same change.

**Solution:** Use the built-in `@orgloop/transform-dedup` transform. It hashes configurable fields and drops duplicates within a time window.

### Basic: deduplicate by event identity

```yaml
transforms:
  - name: dedup
    type: package
    package: "@orgloop/transform-dedup"
    config:
      key:
        - source
        - type
        - payload.pr_number
      window: 5m
```

This drops events where the combination of `source` + `type` + `payload.pr_number` was already seen within the last 5 minutes.

### Per-route dedup with different keys

Different routes may need different dedup strategies. A PR review route deduplicates on the review ID, while a CI route deduplicates on the run ID:

```yaml
# In the route definition, override the transform config
routes:
  - name: pr-reviews
    transforms:
      - ref: dedup
        config:
          key: [source, payload.review_id]
          window: 10m
    # ...

  - name: ci-runs
    transforms:
      - ref: dedup
        config:
          key: [source, payload.run_id]
          window: 30m
    # ...
```

### Wider windows for batch processing

If your actor processes events in batches (e.g., daily digest), use a longer window:

```yaml
config:
  key: [source, type, payload.pr_number]
  window: 24h
```

## Environment variable interpolation

**Problem:** You want to parameterize filter values, author lists, or thresholds without hardcoding them in YAML.

**Solution:** Use `${VAR_NAME}` syntax in any config value. The config loader resolves env vars before transforms see them.

```yaml
transforms:
  - name: team-filter
    type: package
    package: "@orgloop/transform-filter"
    config:
      match_any:
        provenance.pr_author: "${TEAM_MEMBERS}"    # e.g., alice,bob,charlie
      exclude:
        provenance.author: "${EXCLUDED_BOTS}"       # e.g., dependabot[bot],renovate[bot]
```

```bash
# .env
TEAM_MEMBERS=alice,bob,charlie
EXCLUDED_BOTS=dependabot[bot],renovate[bot]
```

Comma-separated values from env vars are automatically expanded to arrays by the filter transform. This means `TEAM_MEMBERS=alice,bob,charlie` becomes a three-element OR match.

Use `orgloop env` to verify your variables are set correctly before starting.

## Transform composition (defense-in-depth pipelines)

**Problem:** You need multiple filtering and enrichment steps — drop bots, deduplicate, filter by team, add metadata.

**Solution:** Chain transforms in your route definition. They execute sequentially, and each one can drop the event.

```yaml
routes:
  - name: team-pr-reviews
    when:
      source: github
      events: [resource.changed]
      filter:
        provenance.platform_event: pull_request.review_submitted
    transforms:
      - ref: drop-bot-noise       # 1. Drop bot-authored events
      - ref: dedup                 # 2. Deduplicate (only sees non-bot events)
      - ref: team-members-only    # 3. Only team member PRs
      - ref: add-team-metadata    # 4. Enrich with team info
    then:
      actor: engineering-agent
    with:
      prompt_file: ./sops/pr-review.md
```

The corresponding transform definitions:

```yaml
transforms:
  - name: drop-bot-noise
    type: package
    package: "@orgloop/transform-filter"
    config:
      exclude:
        provenance.author_type: bot

  - name: dedup
    type: package
    package: "@orgloop/transform-dedup"
    config:
      key: [source, type, payload.pr_number]
      window: 5m

  - name: team-members-only
    type: package
    package: "@orgloop/transform-filter"
    config:
      match_any:
        provenance.pr_author: "${TEAM_MEMBERS}"

  - name: add-team-metadata
    type: package
    package: "@orgloop/transform-enrich"
    config:
      set:
        metadata.team: "platform"
      copy:
        metadata.author: provenance.pr_author
```

Order matters. Filter early to reduce work for later transforms. The typical pipeline order:

1. **Exclude** noise (bots, irrelevant events)
2. **Dedup** to prevent reprocessing
3. **Filter** to refine (team membership, priority, labels)
4. **Enrich** with additional context

## Enrichment patterns

**Problem:** Events from connectors don't have all the context your actor needs — you want to add team names, copy fields to standard locations, or compute derived values.

**Solution:** Use the `@orgloop/transform-enrich` transform.

### Add static fields

```yaml
transforms:
  - name: add-context
    type: package
    package: "@orgloop/transform-enrich"
    config:
      set:
        metadata.team: "platform"
        metadata.priority: "p1"
        metadata.env: "${DEPLOYMENT_ENV}"
```

### Copy fields to standard locations

```yaml
config:
  copy:
    metadata.author: provenance.pr_author
    metadata.repo: provenance.repo
    metadata.event_kind: provenance.platform_event
```

### Compute derived fields

```yaml
config:
  compute:
    metadata.is_bot: "provenance.author_type === 'bot'"
    metadata.is_critical: "payload.priority > 8"
    metadata.needs_review: "payload.status === 'open'"
```

Compute supports comparison operators (`===`, `!==`, `>`, `<`, `>=`, `<=`). The result is a boolean. Use `set` for static values and `copy` for field relocation.

## Route-level filtering with CWD patterns

**Problem:** You use coding agents across multiple projects and want different routing per project directory.

**Solution:** The coding-agent connector emits the working directory in the [normalized lifecycle payload](/spec/lifecycle-contract/) at `payload.session.cwd` (or `payload.cwd` for backward compatibility). Use regex patterns in the transform-filter to route by path.

```yaml
transforms:
  - name: work-projects-only
    type: package
    package: "@orgloop/transform-filter"
    config:
      match:
        payload.session.cwd: '/^\/Users\/alice\/work\//'

  - name: personal-projects-only
    type: package
    package: "@orgloop/transform-filter"
    config:
      match:
        payload.session.cwd: '/\/personal\//'
```

Regex patterns are delimited with forward slashes: `/pattern/flags`. Case-insensitive matching uses the `i` flag: `/pattern/i`.

## Token refresh for expiring credentials

**Problem:** Some APIs use short-lived tokens that expire (e.g., GitHub App installation tokens, OAuth refresh flows).

**Solution:** OrgLoop doesn't manage token lifecycles directly — that's outside its scope ([scope boundaries](/vision/scope-boundaries/)). Instead, use an external credential manager that writes fresh tokens to the environment.

### Pattern: external script + .env reload

1. Write a credential refresh script that obtains a fresh token and writes it to `.env`:

```bash
#!/bin/bash
# refresh-token.sh
NEW_TOKEN=$(your-auth-cli get-token --app-id 12345)
sed -i '' "s/^GITHUB_TOKEN=.*/GITHUB_TOKEN=${NEW_TOKEN}/" .env
```

2. Run it on a schedule (cron, launchd, systemd timer):

```bash
# crontab -e
*/30 * * * * cd /path/to/orgloop-project && ./refresh-token.sh
```

3. OrgLoop reads `${GITHUB_TOKEN}` from the environment at config load time. Restart the daemon after token refresh, or use the config's `token_command` if your connector supports it.

The key principle: OrgLoop routes events, it doesn't manage credentials. Keep credential lifecycle in dedicated tooling where it belongs.

## Supervision loops (actor monitoring actor)

**Problem:** You want one agent to review the output of another — a supervisor pattern.

**Solution:** Use the `actor.stopped` event type. When an actor's session ends, OrgLoop emits an `actor.stopped` event that can be routed to a different actor.

```yaml
routes:
  # Primary work: GitHub events → engineering agent
  - name: engineering-work
    when:
      source: github
      events: [resource.changed]
    then:
      actor: engineering-agent
    with:
      prompt_file: ./sops/engineering.md

  # Supervision: engineering agent completes → supervisor reviews
  - name: supervisor-review
    when:
      source: claude-code
      events: [actor.stopped]
    transforms:
      - ref: engineering-sessions-only
    then:
      actor: supervisor-agent
    with:
      prompt_file: ./sops/supervisor.md
```

The supervisor agent receives the full `actor.stopped` event, including the session payload — what was worked on, exit status, and any output. The supervisor's SOP decides whether the work was adequate.

See the [Multi-Agent Supervisor example](/examples/multi-agent-supervisor/) for a complete working configuration.

## Debugging event flows

**Problem:** Events aren't reaching your actor, or the wrong events are getting through. How do you figure out what's happening?

**Solution:** Use OrgLoop's built-in observability tools.

### See your routes

```bash
orgloop routes
```

Displays all configured routes with their sources, events, transforms, and targets in a visual table.

### Check configuration health

```bash
orgloop validate    # Schema validation, file references, env vars
orgloop doctor      # System health: dependencies, permissions, connectivity
orgloop env         # Environment variable status (set/missing per connector)
```

### Preview what would happen

```bash
orgloop plan        # Dry-run showing what sources, routes, and actors would be created
```

### Inspect live event flow

```bash
orgloop logs --follow          # Stream all pipeline activity
orgloop logs --event evt_xxx   # Trace a specific event through the pipeline
orgloop status                 # Runtime status of sources, actors, routes
```

Every transform decision (pass, drop, error) is logged with the event's trace ID. If an event is being dropped by a transform, the logs will tell you which transform dropped it and why.

## Script transforms for external API enrichment

**Problem:** You want to enrich events with data from an external API — look up a Jira ticket, fetch a user profile, query a database.

**Solution:** Write a script transform that calls the external API and merges the result into the event.

```python
#!/usr/bin/env python3
# transforms/enrich-jira.py
import sys, json, os, urllib.request

event = json.load(sys.stdin)
ticket_id = event.get("payload", {}).get("ticket_id")

if not ticket_id:
    json.dump(event, sys.stdout)  # No ticket, pass through
    sys.exit(0)

# Fetch from Jira
api_token = os.environ.get("JIRA_API_TOKEN", "")
url = f"https://your-org.atlassian.net/rest/api/3/issue/{ticket_id}"
req = urllib.request.Request(url, headers={
    "Authorization": f"Basic {api_token}",
    "Accept": "application/json"
})

try:
    resp = urllib.request.urlopen(req, timeout=5)
    jira_data = json.loads(resp.read())
    event.setdefault("metadata", {})["jira_priority"] = jira_data["fields"]["priority"]["name"]
    event["metadata"]["jira_status"] = jira_data["fields"]["status"]["name"]
except Exception:
    pass  # Fail-open: if Jira is down, event passes through without enrichment

json.dump(event, sys.stdout)
```

```yaml
transforms:
  - name: enrich-jira
    type: script
    script: ./transforms/enrich-jira.py
    timeout_ms: 10000
```

Script transforms can be written in any language. They receive the full event on stdin and write the (optionally modified) event to stdout. See [Building Transforms — Script transforms](/guides/transform-authoring/#script-transforms) for the full contract.

---

## See also

- [Transform Filter Deep Dive](/guides/transform-filter/) — full reference for match, match_any, exclude, jq, regex, and CSV expansion
- [Building Transforms](/guides/transform-authoring/) — how to build script and package transforms
- [Config Schema — Route Definition](/reference/config-schema/#route-definition) — route filter and transform reference
- [Config Schema — Environment Variables](/reference/config-schema/#environment-variable-substitution) — `${VAR}` syntax
- [Multi-Agent Supervisor Example](/examples/multi-agent-supervisor/) — complete supervision loop config
- [Engineering Org Example](/examples/engineering-org/) — full production routing setup
