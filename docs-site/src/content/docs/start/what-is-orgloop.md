---
title: What is OrgLoop?
description: Organization as Code — a declarative event routing system for autonomous AI organizations.
---

OrgLoop is an **Organization as Code** framework -- a declarative event routing system for autonomous AI organizations. It replaces scattered cron jobs and shell scripts with a unified, event-driven runtime.

## The problem

AI agents are capable individually. But running them at organizational scale exposes a structural gap: there is no reliable system to ensure every meaningful state change gets an appropriate response.

You've tried the obvious fixes:

- **Cron jobs and heartbeats.** The agent wakes every 15 minutes and rabbit-holes on one interesting thing while ignoring three urgent ones. Time-based polling is unfocused and lossy.
- **Better prompts.** Elaborate system prompts: "check GitHub, check Linear, check CI..." More instructions don't make a probabilistic system deterministic.
- **More agents.** A GitHub agent, a Linear agent, a CI agent. Now you have a coordination problem. You've moved the glue from human-to-agent to agent-to-agent.

None of this works because you're solving a systems problem with better actors. That's like making a company work by hiring smarter people without building processes.

## The insight

**You don't need reliable actors if you have a reliable system around them.**

Human organizations figured this out centuries ago. No individual is reliable across every dimension. People forget, get sick, make mistakes. So we built processes, handoff protocols, escalation paths. The system ensures outcomes even when actors are imperfect.

AI agents are the same. They're probabilistic, not because the tech is bad, but because that's what actors *are*. This isn't a bug. It's a property to design around.

The breakthrough: **a deterministic layer that ensures every meaningful state change triggers an appropriate response, regardless of whether any individual actor remembers to check.**

An agent told to do a specific job at a specific point in time is pretty reliable. We just need to employ them at the right time, for the right job, with the right instructions.

## Organization as Code

Same shift that happened with servers. SSH'ing into machines and tweaking config files became Infrastructure as Code -- declarative, version-controlled, reproducible. Organization as Code applies that same shift to how organizations operate.

Your event sources, your actors, your wiring -- all declared in config. Auditable. No hidden state, no tribal knowledge, no human glue.

Here's what a minimum viable autonomous engineering org looks like. This example uses GitHub, Linear, Claude Code, and OpenClaw. The [Getting Started guide](/start/getting-started/) walks through setting these up step by step -- starting with a zero-dependency demo.

```yaml
sources:
  - id: github
    connector: "@orgloop/connector-github"
    config:
      repo: "${GITHUB_REPO}"
      token: "${GITHUB_TOKEN}"
    poll:
      interval: 5m
    emits:
      - resource.changed

  - id: linear
    connector: "@orgloop/connector-linear"
    config:
      team: "${LINEAR_TEAM_KEY}"
      api_key: "${LINEAR_API_KEY}"
    poll:
      interval: 5m

  - id: claude-code
    connector: "@orgloop/connector-claude-code"
    config:
      hook_type: post-exit
    emits:
      - actor.stopped

actors:
  - id: openclaw-engineering-agent
    connector: "@orgloop/connector-openclaw"
    config:
      auth_token_env: "${OPENCLAW_WEBHOOK_TOKEN}"

routes:
  - name: "PR review -> Engineering"
    when: { source: github, events: [resource.changed] }
    transforms: [drop-bot-noise]
    then: { actor: openclaw-engineering-agent }
    with: { prompt_file: "./sops/pr-review.md" }

  - name: "CI failure -> Engineering"
    when: { source: github, events: [resource.changed] }
    then: { actor: openclaw-engineering-agent }
    with: { prompt_file: "./sops/ci-failure.md" }

  - name: "Dev session done -> Supervisor"
    when: { source: claude-code, events: [actor.stopped] }
    then: { actor: openclaw-engineering-agent }

  - name: "Ticket moved -> Engineering"
    when: { source: linear, events: [resource.changed] }
    then: { actor: openclaw-engineering-agent }
    with: { prompt_file: "./sops/linear-ticket.md" }
```

Read that and you see an organization's nervous system. Every event that matters, where it goes, what responds. If there's a gap -- a lifecycle event with no route -- it's visible.

## The five primitives

OrgLoop has five building blocks. That's it.

| Primitive | Role |
|-----------|------|
| **Sources** | Things that emit events. A GitHub repo, a Linear project, a Claude Code session. Anything that changes state. |
| **Actors** | Things that do work when woken. An OpenClaw agent, a Claude Code team, a human via notification. |
| **Routes** | Declarative wiring. When source X emits event Y, wake actor Z with context C. Pure routing, no business logic. |
| **Transforms** | Optional pipeline steps. Filter noise, deduplicate, enrich with metadata. Mechanical -- actors handle reasoning, transforms handle plumbing. |
| **Loggers** | Passive observers. Every event, every transform, every delivery -- captured for debugging and audit. |

For a deep dive, see [Five Primitives](/concepts/five-primitives/).

## The loop

Here's what makes it click: **the org loops.** When an actor finishes work, that completion is itself an event -- routed back into the system to trigger the next actor.

```
Source.poll() --> EventBus --> matchRoutes() --> Transforms --> Actor.deliver()
                                                                     |
                                                          actor.stopped --> EventBus
                                                                     (the loop)
```

A dev agent is both an actor (it does work) and a source (its completion emits events). A supervisor evaluates, relaunches, and its own completion feeds back in. The organization sustains itself through continuous cycles of events triggering actors triggering events.

Three event types keep the taxonomy minimal:

| Type | Meaning |
|------|---------|
| `resource.changed` | Something changed in an external system (PR, ticket, CI run, deploy) |
| `actor.stopped` | An actor's session ended (neutral -- the system observes, the receiving actor judges) |
| `message.received` | A human or system sent a message |

`actor.stopped` is deliberately neutral. OrgLoop observes that a session ended. Whether work was completed, the agent crashed, or got stuck -- that's for the receiving actor to judge. OrgLoop routes signals; actors have opinions.

## Launch prompts

Notice the `with` on those routes. That's a **launch prompt** -- a focused SOP delivered alongside the event, telling the actor exactly how to approach this specific situation.

Without launch prompts, the actor's system prompt becomes a grab-bag: "if you get a PR review, do X; if CI fails, do Y; if a ticket moves, do Z..." Scale that to twenty event types and the agent drowns.

Routes carry focused launch prompts. Your actor gets a situational SOP per event, not every possible instruction at once.

```markdown
<!-- sops/pr-review.md -->
# PR Review Received

A team member submitted a review on your PR.

1. Read every comment carefully
2. Code change requests -- make the fix, push
3. Questions -- respond with an explanation
4. Disagreements -- explain your reasoning
5. After addressing all comments, re-request review
```

Same actor, different prompts per route. The routing layer decides which SOP is relevant. The actor doesn't have to figure it out.

## What this unlocks

**Nothing gets dropped.** Every state change triggers a deterministic, immediate, focused response. The right actor wakes with the right context.

**Actors stay focused.** No more scanning broadly for anything that might need attention. Each wake is one job, one SOP, one lifetime.

**Extracted from a working system.** The framework was built to run a real engineering org — PR reviews, CI failures, Claude Code supervision, ticket triage, email routing, weekly updates. It's been handling those autonomously since January 2026. If you're already using Claude Code and OpenClaw separately, OrgLoop is the wiring layer that turns them into a self-sustaining organization.

**Composable workflows.** Connectors, transforms, and loggers are independently publishable npm packages. Anyone can build and share a connector for their platform. Projects use standard `package.json` for dependency management.

**Observability built in.** Every event flows through OrgLoop with a trace ID. What's in flight, what's stalled, what's completing, what's failing -- across every business process.

**Platform-agnostic.** Swap GitHub for GitLab -- new connector, same routes. Swap OpenClaw for a custom framework -- new connector, same routes.

## Next steps

Ready to try it? The [Getting Started guide](/start/getting-started/) walks you through three tiers:

1. **Try it now** -- a zero-dependency demo you can run in 2 minutes with no accounts or tokens
2. **One real source** -- connect GitHub or Linear and see real events flow
3. **Full engineering org** -- the complete setup shown above, with all four connectors wired together

Start wherever makes sense for you. Most people start with the demo and add connectors as they go.

For day-to-day operations, see the [User Guide](/start/user-guide/). For deeper architecture, see [Architecture](/concepts/architecture/).
