---
title: Manifesto
description: "Organization as Code — the vision behind OrgLoop."
---

*By Charlie Hulcher*

---

## The Wall

You're running AI agents. Claude Code, Codex, Deep Research, maybe all of them. Each one is genuinely capable. And yet you're still the glue.

Claude Code finishes at 3am and nobody picks up the output. CI fails and no agent notices. You're context-switching between tools, checking dashboards, remembering what finished and what didn't. The agents have capability — what's missing is the coordination layer between them.

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

Events are generated programmatically and flow through deterministic routing, not chat threads. You are not dependent on a heartbeat eventually finding the right state, an Agent remembering to call a tool, nor a patrol coming across something important. When an actor finishes, its completion fires an event back into the system, and the loop continues.

And it's an open architecture. Any system with an API can be a source. Any agent, webhook, or human can be an actor. The primitives don't care what's on either end — write a connector and you're in. Build your organization with all of your specialized agents: Claude Code implementers, OpenClaw supervisors, Deep Research analysts. Connect GitHub, Linear, Gmail, whatever. There are pre-built connectors, and they're easy to contribute.

> We don't implement the action. We automate the nudge, with direction.

An agent told to do a specific job at a specific point in time is pretty reliable. We just need to employ them at the right time, for the right job, with the right instructions.

No amount of LLMs getting better makes it a good idea to stuff a 600-line SOP into an agent that wakes on an hourly heartbeat to triage 1,000 notifications. The next model generation will be smarter, but you're still playing on hard mode. A focused agent with a focused prompt, woken at the right moment, handles it today. You don't need to wait for superintelligence to keep up with your ticket queue.

🧬 **Infrastructure as code reshaped how we manage systems. Organization as code reshapes how we manage intelligence.** LLMs make it possible to define entire autonomous organizations — with routing, escalation, handoffs, and recovery — in declarative, repeatable, deployable configurations. That's the bet OrgLoop is making.

## 🧬 Organization as Code

I call this paradigm **Organization as Code**.

Same shift that happened with servers. SSH'ing into machines and tweaking config files became Infrastructure as Code. Declarative. Version-controlled. Reproducible. Organization as Code applies that same shift to how organizations operate. Your event sources, your actors, your wiring — all declared in config. Auditable, diffable, reproducible. No hidden state, no tribal knowledge, no human glue.

My minimum viable autonomous engineering org:

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
    transforms: [drop-bot-noise, dedup]
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

**Transforms** are optional pipeline steps. Filter noise, deduplicate, enrich with metadata. Mechanical. Actors handle reasoning, transforms handle plumbing.

**Loggers** are passive observers. Every event, every transform, every delivery, captured for debugging and audit.

**The org loops.** 🧬 When an actor finishes work, that completion is itself an event, routed back into the system to trigger the next actor:

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

The dev agent is both an actor (it does work) and a source (its completion emits events). The supervisor evaluates, relaunches, and its own completion feeds back in. The organization sustains itself through continuous cycles of events triggering actors triggering events.

## What This Looks Like Running

I've been running this system for my own engineering org — 6 connectors (GitHub, Linear, Claude Code, OpenClaw, Gmail, cron), two route groups covering engineering and product workflows, 9 SOPs. The framework you're reading about was extracted from that setup.

A typical night: a PR gets a review comment at 2am. The GitHub source catches it, the route matches, the agent wakes with the PR review SOP and addresses the feedback — pushes fixes, re-requests review. If CI breaks on that push, the CI failure route catches it and the agent wakes again with a different SOP. When a Claude Code session finishes at 3am, the hook fires, the supervisor evaluates, and relaunches for QA if the work is ready. Each completion triggers the next step. That's the loop in practice.

The full pipeline — Linear ticket through to feedback-addressed, CI-passing PR — runs without a human in the loop. So does email triage, and a cron-scheduled weekly product update that synthesizes GitHub and Linear activity into a summary for the team.

## Launch Prompts: Skills for Events

Notice the `with` on those routes. That's a **launch prompt** — a focused SOP delivered alongside the event, telling the actor exactly what to do in this specific situation. The actor doesn't just get *notified* that something happened. It gets a scoped SOP for exactly what happened.

This is the key differentiator. Without launch prompts, the actor's system prompt becomes a grab-bag: "if you get a PR review, do X; if CI fails, do Y; if a ticket moves, do Z..." Scale that to twenty event types and the agent drowns. The same way a skill gives an agent a specific capability, a route gives an agent situational purpose. One job, one SOP, one lifetime.

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

**Installable Autonomous Organizations.** This is where it gets interesting. Think about what an OrgLoop project actually is: it's an entire operational topology, defined as code. My engineering org -- the sources, routes, transforms, SOPs, and a `package.json` declaring every connector dependency -- is a project you can clone and run. The project doesn't just give you YAML files. It declares the full truth about what it needs via `orgloop.yaml` and connector setup metadata, and OrgLoop tells you exactly what's missing and how to get it. Clone the project, install packages, follow the guidance, start. You just replicated a functioning autonomous engineering department.

These aren't templates. They're complete operational topologies with declared dependencies -- installable autonomous organizations. Your org config is code: version it, diff it, clone it, deploy it. And if a dependency isn't ready yet -- an actor isn't running, a service isn't installed -- the system doesn't break. Events queue. The routing layer keeps working. You add the missing piece when you're ready, and everything catches up.

**A foundation for observability.** Every event flows through OrgLoop with a trace ID. What's in flight, what's stalled, what's completing, what's failing, across every business process. This is the foundation for the oversight layer that lets you manage at the level of objectives, not individual agent sessions.

**Launch prompts that scale.** Route-paired SOPs mean your actors get sharper as your org grows more complex, not duller. Twenty routes means twenty focused instructions, not one bloated system prompt.

**Open-ended by design.** Connectors, transforms, and loggers are independently publishable packages. GitHub today, Salesforce tomorrow, your internal tools next week — whatever you want, use an existing connector or contribute one. No approval needed, no registry gatekeeping. OrgLoop isn't limited to the connectors that exist today. The system is a platform, not a product with a fixed integration list.

**Security as a first-class concern.** Transforms give you a standardized place to implement security policy: prompt injection scanning, provenance-based filtering, rate limiting. Declared in your org spec and auditable.

**A common pattern beyond engineering.** The same YAML structure works for any process where events trigger work. Now imagine where this goes:

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

Same five primitives. Different connectors. The engineering org is the proof case, not the ceiling. Someone builds a customer support flow -- Zendesk + Intercom + triage routes + escalation SOPs -- and shares it as a project template. Someone else packages an entire DevOps org: PagerDuty + Datadog + runbook agents + incident response routes. Clone, install, configure, run.

## The Autonomy Ladder

Most teams are stuck in copilot mode — AI does work, humans review everything. Some have pushed into supervised territory, where AI works autonomously but humans still monitor and intervene. Very few have reached true autonomy: the system runs itself, humans observe and steer.

The gap between supervised and autonomous isn't actor intelligence. It's the absence of a system that ensures work accumulates toward objectives over long time horizons. The human is still the glue, routing decisions and nudges through themselves.

The real question: can I define an objective and have event sources acted on from input to output with no human in the loop?

Organization as Code is what closes that gap. Not by making actors smarter, but by making the system around them deterministic, steerable, and debuggable.

## Where We Are

Alpha. The framework is extracted from the production system described above. Projects are package-native -- a directory with `orgloop.yaml` and a `package.json` listing connector dependencies. Connectors, transforms, and loggers are npm packages installed with `npm install`. Single-process, single-machine runtime today. Distributed execution is on the roadmap, but a single machine handles a real engineering org's event volume fine.

## OrgLoop

I'm building this in the open. The reference implementation is called **OrgLoop**, because the defining feature is the loop.

The agents aren't the problem. The system around them is.

---

**OrgLoop is open source under the MIT license.** Read the code, run it, build on it, contribute to it.

```bash
npm install -g @orgloop/cli
orgloop init --connectors github,linear,openclaw,claude-code
cd my-org
npm install
# orgloop doctor tells you what's needed and how to get it
orgloop start
```

You just set up an engineering organization. The routes are running. Events are flowing. Your actors are waking with focused SOPs. The org loops.

