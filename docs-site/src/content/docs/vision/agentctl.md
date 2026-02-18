---
title: "agentctl: Agent Execution Harness"
description: The missing layer between OrgLoop's event routing and the agents that do the work.
---

OrgLoop routes events to actors. But what happens when the actor wakes up?

Launching an agent session is only the beginning. You need to track it, log its output, prevent two sessions from colliding in the same worktree, tear down resources when they're done, and let the human take over without stopping the whole system. That's **agentctl** -- an execution harness that sits between OrgLoop and the agents.

## Origin: Battle-Tested Prototype

agentctl started as `agent-ctl`, a TypeScript CLI built out of necessity while running an autonomous engineering organization. The prototype has been in daily production since January 2026, managing Claude Code sessions across multiple git worktrees under OpenClaw supervision.

What it does today:

```bash
agent-ctl launch "Fix the failing CI tests" --cwd ~/code/my-repo
agent-ctl list                     # Show running sessions
agent-ctl peek abc123              # Tail recent output
agent-ctl kill abc123              # Kill + mark as human-cancelled
agent-ctl resume abc123 "Try a different approach"
agent-ctl cleanup                  # Clean up orphaned sessions
```

Key capabilities proven in production:

- **Supervised launch** -- spawns Claude Code with PTY-based real-time output streaming, structured logging per session
- **Session registry** -- tracks active/completed sessions with metadata (PID, cwd, spec, timestamps, exit codes)
- **Human cancellation** -- marks sessions as human-killed so the supervisor knows not to restart them
- **Session resume** -- resumes sessions with optional new guidance, preserving full context
- **Supervisor notification** -- POSTs to OpenClaw on completion with enough context for the supervisor to decide: relaunch, escalate, or close
- **Orphan cleanup** -- detects sessions whose processes died without completing

## The Problems It Solves

Running the prototype revealed a class of problems that don't belong in OrgLoop (routing) or orgctl (bootstrap):

### 1. Worktree Contention

Two events arrive for the same git worktree. Without coordination, two Claude Code sessions start in the same directory. File conflicts, git conflicts, wasted compute.

**agentctl's answer: worktree locking.**

```bash
agentctl lock ~/code/my-repo --reason "Manual debugging"
# All agent sessions for this worktree queue until unlocked

agentctl unlock ~/code/my-repo
# Queued events drain in order
```

Two types of locks:
- **Agent lock** -- acquired automatically on session launch, released on completion. If a second event arrives, it queues locally until the lock releases.
- **Human lock** -- acquired explicitly. Blocks all agent sessions. OrgLoop keeps routing -- events queue in agentctl, not in OrgLoop. When unlocked, everything catches up.

The key insight: **OrgLoop doesn't need to know about locks.** It delivers events to the actor connector as normal. The connector delegates to agentctl. agentctl handles contention transparently.

### 2. Resource Lifecycle

A Claude Code session spins up a local k8s cluster for integration testing. The session finishes, but the cluster keeps running. The current workaround: a per-worktree shell script with a time-delay fuse. Bespoke and fragile.

**agentctl's answer: lifecycle hooks.**

```yaml
# ~/.agentctl/hooks.yaml
hooks:
  - event: session.end
    scope: worktree
    match: "*/integration-*"
    action:
      command: "kubectl delete namespace test-${WORKTREE_NAME}"
      delay: 30m                   # Tear down 30 min after session ends
      cancel_on: session.start     # Cancel if a new session starts first
```

| Hook Event | When | Example |
|------------|------|---------|
| `session.start` | Session begins | Spin up dev server, start k8s cluster |
| `session.end` | Session ends | Arm teardown timer |
| `session.idle` | No output for N minutes | Alert supervisor |
| `session.error` | Session crashes | Capture diagnostics |
| `lock.timeout` | Lock held too long | Alert human, auto-release |

The `delay` + `cancel_on` pattern is the time-delay fuse: don't tear down immediately (the supervisor might relaunch), but don't leave resources running forever.

### 3. Human Override

You see an agent heading in the wrong direction and want to take over the worktree. But OrgLoop is still routing events, and the supervisor might launch another session any moment.

**agentctl's answer: human locks that don't stop OrgLoop.**

```bash
# Take over
agentctl kill abc123               # Kills session, marks human-cancelled
agentctl lock ~/code/my-repo       # Blocks new sessions

# Work locally as long as you need...

# Hand back
agentctl unlock ~/code/my-repo     # Queued events drain
# The org keeps looping
```

OrgLoop never stops. Events keep routing. They just queue at the execution layer until the human is done. No reconfiguration, no restart, no state loss.

### 4. Agent Abstraction

The supervisor currently calls Claude Code with hardcoded CLI flags. Adding Codex, or a custom agent, or switching a worktree to a different runtime means editing shell scripts.

**agentctl's answer: pluggable agent runtimes.**

```yaml
# ~/.agentctl/agents.yaml
agents:
  claude-code:
    runtime: claude-code
    launch:
      command: "claude"
      args: ["--dangerously-skip-permissions", "--print", "--output-format", "stream-json"]
      resume_flag: "-r"
    output: { format: stream-json }

  codex:
    runtime: codex
    launch:
      command: "codex"
      args: ["--full-auto"]
    output: { format: text }
```

```bash
agentctl launch --agent claude-code --prompt "Fix tests"
agentctl launch --agent codex --prompt "Fix tests"
# Same session management. Different runtimes.
```

Actor connectors become thin -- they translate OrgLoop events into `agentctl launch` calls. All session complexity lives in agentctl.

## Three Layers, Three Concerns

```
orgctl (bootstrap)    OrgLoop (routing)    agentctl (execution)
─────────────────     ────────────────     ─────────────────────
Install services      Event routing        Session launch
Broker credentials    Transform pipeline   Worktree locking
Configure hooks       Actor delivery ────> Resource lifecycle
                      Logging              Output capture
                                           Human override
                                           Session resume
```

Each layer has its own security model, lifecycle, and failure modes:

- **orgctl** runs once to get you to the point where events can flow
- **OrgLoop** runs continuously, routing events to the right actors
- **agentctl** runs on demand, managing what happens when an actor is woken

Bundling them would create a monolith. Separating them means each layer can be trusted, debugged, and extended independently.

## Integration with OrgLoop

OrgLoop's actor connectors delegate to agentctl:

```typescript
// Inside an actor connector
async deliver(event: OrgLoopEvent): Promise<DeliveryResult> {
  const result = await exec(`agentctl launch \
    --worktree ${event.provenance.cwd} \
    --agent claude-code \
    --prompt "${event.payload.prompt}" \
    --event-id ${event.id}`);

  return { status: 'accepted', tracking_id: result.sessionId };
}
```

agentctl handles locking, lifecycle hooks, and output capture. The connector stays thin. When the session completes, OrgLoop's `actor.stopped` pipeline routes the completion event back into the system. The org loops.

## Implementation Status

**Phase 1 (extract and normalize)** can begin immediately -- the prototype is proven and running in production.

| Phase | Scope | Status |
|-------|-------|--------|
| 1. Extract & normalize | Session lifecycle (launch, list, kill, resume, cleanup) | Prototype proven |
| 2. Worktree locking | Agent locks, human locks, event queuing | Designed |
| 3. Resource hooks | Lifecycle hooks, time-delay fuse, cancel-on-relaunch | Designed |
| 4. Agent abstraction | Pluggable runtimes, normalized launch interface | Designed |

## The Full Stack

```bash
# Bootstrap the environment
orgctl bootstrap --project ./my-org --github-repo my-org/my-repo

# Start the routing layer
orgloop start

# Events route. Agents wake via agentctl.
# Worktrees are locked. Resources spin up and tear down.
# Take over any worktree, any time. Events queue, not drop.
# The org loops.
```

See the full [agentctl RFP](https://github.com/c-h-/orgloop/blob/main/docs/rfp-agentctl.md) for technical details, scope boundaries, and implementation phases.
