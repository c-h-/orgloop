---
title: "Scope Boundaries"
description: "What OrgLoop does vs. doesn't do, the shared module manifest contract, connector maturity stages, and the orchestrator vision."
---

### OrgLoop's Identity

OrgLoop is an **event routing layer** for autonomous organizations. It declares what an organization needs, routes events between sources and actors, and validates the environment. It does not install software, manage service lifecycles, or broker credentials.

This boundary is deliberate. The routing layer must be lightweight, focused, and trustworthy. The moment it takes responsibility for installing OpenClaw or managing GitHub OAuth flows, it becomes a different kind of tool — one with a different security model, different dependencies, and different failure modes.

But OrgLoop *should* make the path to a fully operational environment as obvious and friction-free as possible. The way it does this: **declare the full truth in a machine-readable contract, and let specialized tools act on it.**

### The Shared Contract: Module Manifest

The module manifest (`orgloop-module.yaml`) is designed for **multiple consumers**. OrgLoop reads the parts it needs. External tools read the parts they need. Same file, different audiences.

```
┌───────────────────────────────────────────────────────────┐
│                   orgloop-module.yaml                      │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │ connectors  │  │ services     │  │ credentials      │ │
│  │ routes      │  │ install hints│  │ oauth flows      │ │
│  │ transforms  │  │ health checks│  │ cross-system     │ │
│  │ parameters  │  │ hooks        │  │ keychain storage │ │
│  └──────┬──────┘  └──────┬───────┘  └────────┬─────────┘ │
└─────────┼────────────────┼────────────────────┼───────────┘
          │                │                    │
    ┌─────▼─────┐   ┌─────▼──────┐   ┌────────▼────────┐
    │  OrgLoop  │   │ Orchestr.  │   │ Cred. Broker    │
    │  (router) │   │ (sister    │   │ (connector      │
    │           │   │  project)  │   │  maturity or    │
    │ Reads:    │   │            │   │  sister project)│
    │ connectors│   │ Reads:     │   │                 │
    │ routes    │   │ services   │   │ Reads:          │
    │ transforms│   │ install    │   │ credentials     │
    │ parameters│   │ hooks      │   │ oauth           │
    └───────────┘   └────────────┘   └─────────────────┘
```

**Design rule:** OrgLoop MUST function correctly if `services`, `credentials`, and `hooks` are entirely absent from the manifest. They are informational for OrgLoop (used by `orgloop doctor`), actionable for external tools.

### What OrgLoop Does

| Capability | How |
|---|---|
| Declare full dependency graph | Module manifest with `requires` block |
| Validate environment | `orgloop doctor` reports what's present, missing, degraded |
| Run in degraded mode | Queue actor stores events when actors are unavailable |
| Upgrade gracefully | `orgloop upgrade` promotes degraded actors to live |
| Surface connector guidance | Connector `setup` metadata provides per-var help text, URLs |
| Machine-readable diagnostics | `orgloop doctor --json` for automation and external tools |
| Non-interactive installation | `orgloop add module --non-interactive --param X=Y` |

### What OrgLoop Does NOT Do

| Capability | Why not | Who does it |
|---|---|---|
| Install software (brew, apt, docker) | Different security model, platform-specific | Orchestrator (sister project) |
| Manage service lifecycles (start/stop/health) | OrgLoop is a daemon, not an init system | Orchestrator |
| Run OAuth flows | Requires temp HTTP server, browser integration | Connector maturity or orchestrator |
| Generate/distribute shared tokens | Cross-system credential coordination | Orchestrator |
| Store credentials in OS keychain | Platform-specific, security-critical | Orchestrator |
| Create resources in external systems | OrgLoop configures itself, not others | External system's own CLI/UI |

### Connector Maturity Stages

Connectors evolve through maturity stages. Each stage adds optional capabilities that OrgLoop and external tools can leverage. Connector authors control the pace.

**Stage 1: Functional** (MVP requirement)

Implements `source` or `target`. Config accepts env var references. Works.

```typescript
register(): ConnectorRegistration {
  return { id: 'github', source: GitHubSource };
}
```

**Stage 2: Discoverable** (enables `orgloop doctor`)

Adds `setup` metadata (env var descriptions, help URLs) and optionally `service_detector` and `credential_validators`.

```typescript
register(): ConnectorRegistration {
  return {
    id: 'github',
    source: GitHubSource,
    setup: {
      env_vars: [
        { name: 'GITHUB_TOKEN', description: 'Personal access token (repo scope)',
          help_url: 'https://github.com/settings/tokens/new?scopes=repo,read:org' }
      ],
    },
    credential_validators: {
      GITHUB_TOKEN: { validate: async (token) => { /* test API call */ } },
    },
  };
}
```

**Stage 3: Self-service** (enables `orgloop setup` credential acquisition)

Adds `credential_acquirers` — the connector can obtain credentials itself (OAuth, API calls).

```typescript
credential_acquirers: {
  GITHUB_TOKEN: {
    type: 'oauth',
    oauth: {
      authorize_url: 'https://github.com/login/oauth/authorize',
      token_url: 'https://github.com/login/oauth/access_token',
      scopes: ['repo', 'read:org'],
      client_id: 'orgloop-github-app-id',
    },
    acquire: async () => { /* open browser, run OAuth flow */ },
  },
},
```

Each stage is backward-compatible. A Stage 1 connector works fine — it just provides less guidance. `orgloop doctor` and external tools gracefully degrade based on what the connector reports.

### The Orchestrator Vision

A sister project (working name: `orgctl`) reads the same module manifest and handles what OrgLoop doesn't: service installation, credential brokering, cross-system configuration.

```bash
# The vision
orgctl bootstrap @orgloop/module-engineering --github-repo my-org/my-repo

# orgctl does:
# 1. npm install (connector deps)
# 2. Install services (brew install openclaw && openclaw start)
# 3. Wait for health checks
# 4. Broker credentials (GitHub OAuth, OpenClaw token generation)
# 5. Write .env
# 6. orgloop add module engineering --non-interactive
# 7. orgloop start
```

OrgLoop doesn't know or care that `orgctl` exists. It reads the same YAML it always reads. The orchestrator is a consumer of OrgLoop's stable interfaces: the manifest schema, the `orgloop doctor --json` output, and the `--non-interactive` CLI flags.

See the [orgctl RFP](https://orgloop.ai/vision/orgctl/) for the full project specification.

### Interface Commitments

These interfaces are designed for external consumption and should be treated as stable once shipped:

1. **Module manifest schema** — Published as JSON Schema from `@orgloop/sdk`. External tools validate against it.
2. **`orgloop doctor --json`** — Machine-readable environment diagnostics. The API between OrgLoop and any orchestration tool.
3. **`--non-interactive` flags** — On `orgloop add module` and `orgloop setup`. Enables scripted/automated installation.
4. **`ConnectorRegistration` extensions** — `setup`, `service_detector`, `credential_validators`, future `credential_acquirers`. The building blocks for progressive DX.

### DX Progression: Today -> Tomorrow -> Vision

**Today (ship now):**
```
orgloop init → orgloop env (✓/✗ + helper text) → manually fix → orgloop start
```
User does manual service installation and credential creation. OrgLoop guides honestly.

**Tomorrow (connector maturity):**
```
orgloop init → orgloop setup (OAuth prompts, auto-detection) → orgloop start
```
Connectors at Stage 2-3 handle credential acquisition. No manual token pasting.

**Vision (orchestrator):**
```
orgctl bootstrap @orgloop/module-engineering → done
```
One command. Blank machine to running org.

Each stage is reachable without the previous one. The orchestrator doesn't require Stage 3 connectors (it can install services and prompt for tokens). Stage 3 connectors don't require the orchestrator (they work in `orgloop setup`). The pieces compose independently.
