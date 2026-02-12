---
title: Manifesto
description: "Organization as Code — the vision behind OrgLoop."
---

*By Charlie Hulcher*

---

## The Wall

You're running AI agents. OpenClaw, Claude Code, Codex, Deep Research, Gas Town, maybe all of them. Each one is genuinely capable. And yet you're still the glue.

You're the one who remembers that Claude Code finished at 3am and nobody picked up the output. The one who notices CI failed three hours ago and no agent caught it. The one awake at 2am thinking "did that PR ever get reviewed?" The intelligence exists, but the scaffolding to scale it doesn't.

You've tried the obvious fixes:

- **Cron jobs and heartbeats.** The agent wakes every 15 minutes and rabbit-holes on one interesting thing while ignoring three urgent ones. Time-based polling is unfocused. It's lossy.
- **Better prompts.** Elaborate system prompts: "check GitHub, check Linear, check CI..." More instructions don't make a probabilistic system deterministic.
- **More agents.** A GitHub agent, a Linear agent, a CI agent. Now you have a coordination problem. You've moved the glue from human-to-agent to agent-to-agent.

None of this works because you're solving a systems problem with better actors. That's like making a company work by hiring smarter people without building processes.

## The Insight

**You don't need reliable actors if you have a reliable system around them.**

Human organizations figured this out centuries ago. No individual is reliable across every dimension. People forget, get sick, make mistakes. So we built processes, handoff protocols, escalation paths. The system ensures outcomes even when actors are imperfect.

AI agents are the same. They're probabilistic, not because the tech is bad, but because that's what actors *are*. This isn't a bug. It's a property to design around.

The breakthrough: **a deterministic layer that ensures every meaningful state change triggers an appropriate response, regardless of whether any individual actor remembers to check.**

And it's an open architecture. Any system with an API can be a source. Any agent, webhook, or human can be an actor. GitHub today, Workday tomorrow, your internal tools next week. The primitives don't care what's on either end. You write a connector, you're in.

> We don't implement the action. We automate the nudge, with direction.

An agent told to do a specific job at a specific point in time is pretty reliable. We just need to employ them at the right time, for the right job, with the right instructions.

And here's what people miss: no amount of LLMs getting better makes it a good idea to stuff a 600-line SOP into an agent that wakes on an hourly heartbeat to triage 1,000 notifications. Yes, the next model generation will be smarter. But you're still playing on hard mode. This simple architectural solve means you don't need to wait for superintelligence to keep up with your ticket queue. A focused agent with a focused prompt, woken at the right moment, handles it today.

## 🧬 Organization as Code

I call this paradigm **Organization as Code**.

Same shift that happened with servers. SSH'ing into machines and tweaking config files became Infrastructure as Code. Declarative. Version-controlled. Reproducible. Organization as Code applies that same shift to how organizations operate. Your event sources, your actors, your wiring, all declared in config. Auditable. No hidden state, no tribal knowledge, no human glue.

Here's what my minimum viable autonomous engineering org looks like:

```yaml
# orgloop.yaml

sources:
  - id: github
    connector: "@orgloop/connector-github"
    config:
      repo: "${GITHUB_REPO}"
      token: "${GITHUB_TOKEN}"
    poll: { interval: 5m }

  - id: linear
    connector: "@orgloop/connector-linear"
    config:
      team: "${LINEAR_TEAM_KEY}"
      api_key: "${LINEAR_API_KEY}"
    poll: { interval: 5m }

  - id: claude-code
    connector: "@orgloop/connector-claude-code"
    config: { hook_type: post-exit }

actors:
  - id: engineering
    connector: "@orgloop/connector-openclaw"
    config:
      auth_token_env: "${OPENCLAW_WEBHOOK_TOKEN}"

routes:
  - name: "PR review -> Engineering"
    when: { source: github, events: [resource.changed] }
    transforms: [drop-bot-noise, injection-scanner]
    then: { actor: engineering }
    with: { prompt_file: "./sops/pr-review.md" }

  - name: "CI failure -> Engineering"
    when: { source: github, events: [resource.changed] }
    then: { actor: engineering }
    with: { prompt_file: "./sops/ci-failure.md" }

  - name: "Dev session done -> Supervisor"
    when: { source: claude-code, events: [actor.stopped] }
    then: { actor: engineering }

  - name: "Ticket moved -> Engineering"
    when: { source: linear, events: [resource.changed] }
    then: { actor: engineering }
    with: { prompt_file: "./sops/linear-ticket.md" }
```

Read that and you see an organization's nervous system. Every event that matters, where it goes, what responds. If there's a gap, a lifecycle event with no route, it's visible. If something's firing too much or not enough, the logs tell you.

## The Five Primitives

**Sources** are things that emit events. A GitHub repo, a Linear project, a Claude Code session. Anything that changes state.

**Actors** are things that do work when woken. An OpenClaw agent, a Claude Code team, a human via notification.

**Routes** are declarative wiring. When source X emits event Y, wake actor Z with context C. Pure routing, no business logic.

**Transforms** are optional pipeline steps. Filter noise, scan for prompt injection, rate-limit. Mechanical. Actors handle reasoning, transforms handle plumbing.

**Loggers** are passive observers. Every event, every transform, every delivery, captured for debugging and audit.

And here's what makes it click: **the org loops.** 🧬 When an actor finishes work, that completion is itself an event, routed back into the system to trigger the next actor:

```yaml
# The loop: Claude Code finishes -> supervisor evaluates -> relaunches if needed

sources:
  - id: claude-code
    connector: "@orgloop/connector-claude-code"
    config: { hook_type: post-exit }    # Emits actor.stopped when a session ends

actors:
  - id: supervisor
    connector: "@orgloop/connector-openclaw"
    config: { auth_token_env: "${OPENCLAW_WEBHOOK_TOKEN}" }

routes:
  # Step 1: Dev agent finishes -> supervisor wakes to evaluate
  - name: "Dev done -> Supervisor"
    when: { source: claude-code, events: [actor.stopped] }
    then: { actor: supervisor }
    with: { prompt_file: "./sops/evaluate-dev-output.md" }

  # Step 2: Supervisor finishes -> could relaunch dev, open PR, or escalate
  # The supervisor's completion is ALSO an actor.stopped event
  # which could trigger yet another route. The org loops.
```

The dev agent is both an actor (it does work) and a source (its completion emits events). The supervisor evaluates, relaunches, and its own completion feeds back in. The organization sustains itself through continuous cycles of events triggering actors triggering events. That's **OrgLoop**.

## Launch Prompts: Focused Context Beats Overwhelming Context

Notice the `with` on those routes. That's a **launch prompt**, a focused SOP delivered alongside the event, telling the actor exactly how to approach this specific situation.

Without launch prompts, the actor's system prompt becomes a grab-bag: "if you get a PR review, do X; if CI fails, do Y; if a ticket moves, do Z..." Scale that to twenty event types and the agent drowns. This is the same problem that led OpenClaw from MCP tools (everything loaded always) to Skills (focused, loaded only when relevant). The agent performs dramatically better with one clear SOP than a menu of twenty.

Routes carry focused launch prompts. Your actor gets situational SOPs per event, not every possible instruction at once. The actor owns its identity and capabilities. The route owns the situational instructions.

```markdown
<!-- sops/pr-review.md -->
# PR Review Received

A team member submitted a review on your PR.

1. Read every comment carefully
2. Code change requests -> make the fix, push
3. Questions -> respond with an explanation
4. Disagreements -> explain your reasoning
5. After addressing all comments, re-request review
```

Same actor, different prompts per route. The routing layer decides which SOP is relevant. The actor doesn't have to figure it out.

## What This Gets You

**Nothing gets dropped.** Every state change triggers a deterministic, immediate, focused response. The right actor wakes with the right context for exactly what changed.

**Actors stay focused.** No more scanning broadly for anything that might need attention. Each wake is one job, one SOP, one lifetime. If it fails, the system catches the failure and routes that too.

**Humans become optional.** Not eliminated, optional. Where you trust the actors and the SOPs, the system runs autonomously. You observe via logs and intervene when needed. You're not the glue anymore.

**It scales declaratively.** New source? Add a connector. New actor? Add a connector. New wiring? Add a route.

**It's platform-agnostic.** Swap GitHub for GitLab, new connector, same routes. Swap OpenClaw for a custom framework, new connector, same routes.

## What This Unlocks

Infrastructure as Code didn't just make servers easier to manage. It created an entirely new category of tooling, visibility, and capability. Organization as Code does the same.

**A common pattern for your entire organization.** That engineering pipeline I showed? The same YAML structure works for any process where events trigger work:

```yaml
# HR: New hire in Workday -> onboarding agent drafts welcome email + provisions accounts
- when: { source: workday, events: [resource.changed] }
  then: { actor: onboarding-agent }
  with: { prompt_file: "./sops/new-hire-onboarding.md" }

# Sales: Deal stage changed in Salesforce -> sales ops agent updates forecast + alerts AE
- when: { source: salesforce, events: [resource.changed] }
  then: { actor: sales-ops-agent }
  with: { prompt_file: "./sops/deal-stage-change.md" }

# Support: P1 ticket opened in Zendesk -> triage agent pulls logs + drafts response
- when: { source: zendesk, events: [resource.changed] }
  then: { actor: support-triage }
  with: { prompt_file: "./sops/p1-triage.md" }
```

Same five primitives. Different connectors. The engineering org is the proof case, not the ceiling.

**A foundation for observability.** Every event flows through OrgLoop with a trace ID. What's in flight, what's stalled, what's completing, what's failing, across every business process. This is the foundation for the oversight layer that lets you manage at the level of objectives, not individual agent sessions.

**Launch prompts that scale.** Route-paired SOPs mean your actors get sharper as your org grows more complex, not duller. Twenty routes means twenty focused instructions, not one bloated system prompt. The MCP tools to Skills insight, applied to organizational wiring.

**Composability.** Connectors, transforms, and loggers are independently publishable packages. Anyone can build and share a connector for their platform. No approval needed, no registry gatekeeping. The ecosystem grows without bottlenecks.

**Installable Autonomous Organizations.** This is where it gets interesting. Think about what a module actually is: it's an entire operational workflow, packaged as code. My engineering org -- the sources, routes, transforms, SOPs, and a manifest declaring every dependency down to the API tokens and external services -- is a module you can install. The module doesn't just give you YAML files. It declares the full truth about what it needs, and OrgLoop tells you exactly what's missing and how to get it. Install the module, follow the guidance, start. You just cloned a functioning autonomous engineering department.

Now scale that idea. Someone builds a killer customer support flow: Zendesk + Intercom + a triage agent + escalation routes + resolution SOPs. They publish it. You install it. Someone else packages an entire DevOps org: PagerDuty + Datadog + runbook agents + incident response routes. Install, configure, run.

These aren't templates. They're running organizations you can clone. A task, a role, a department, a full org chart. Packaged, versioned, installable. And if a dependency isn't ready yet -- an actor isn't running, a service isn't installed -- the system doesn't break. Events queue. The routing layer keeps working. You add the missing piece when you're ready, and everything catches up. The app store for autonomous organizations.

**Security as a first-class concern.** Transforms give you a standardized place to implement security policy: prompt injection scanning, provenance-based filtering, rate limiting. Declared in your org spec and auditable.

## The Autonomy Ladder

1. **Manual:** Human does everything, AI assists occasionally
2. **Copilot:** AI does work, human reviews everything
3. **Supervised:** AI works autonomously, human monitors and intervenes
4. **Autonomous:** System runs itself, human observes and steers

Most teams are stuck between 2 and 3. They have capable actors but no system to ensure work accumulates toward objectives over long time horizons. The human is still the glue, routing decisions and nudges through themselves, thinking this is what AI can do.

The real question: can I define an objective and have event sources acted on from input to output with no human in the loop?

Organization as Code is what enables level 4. Not by making actors smarter, but by making the system around them deterministic, steerable, and debuggable.

## OrgLoop

I'm building this in the open. The reference implementation is called **OrgLoop**, because the defining feature is the loop.

It's already proven. My "ticket to human-caliber PR" pipeline runs autonomously: Linear ticket to feedback-addressed, CI-passing, QA-evidence-attached pull request, no human in the loop. When a PR gets a review comment at 2am, the poller catches it, wakes the OpenClaw agent with the PR review SOP, OpenClaw launches a Claude Code Team when appropriate, and feedback is addressed. When the Claude Code Team finishes at 3am, the hook fires, the supervisor evaluates, and relaunches for QA. I have the confidence to scale the rest of the org without forgetting how the wiring works.

The agents aren't the problem. The system around them is.

---

**OrgLoop is open source under the MIT license.** Read the code, run it, build on it, contribute to it.

The demo I'm building toward:

```bash
npm install -g @orgloop/cli
npm install @orgloop/module-engineering
orgloop add module engineering
# orgloop doctor tells you what's needed and how to get it
orgloop start
```

You just installed my engineering organization. The routes are running. Events are flowing. Your actors are waking with focused SOPs. The org loops. 🧬

---

*Charlie Hulcher is a founding engineer at Kindo, where he builds AI-powered enterprise software. He runs an autonomous engineering organization using OpenClaw, Claude Code, and a growing cast of AI actors, held together by Organization as Code.*
