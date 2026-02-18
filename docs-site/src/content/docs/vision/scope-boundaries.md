---
title: Scope & Boundaries
description: What OrgLoop does and doesn't do — and how it interfaces with the broader ecosystem.
---

## OrgLoop's Identity

OrgLoop is an **event routing layer** for autonomous organizations. It declares what an organization needs, routes events between sources and actors, and validates the environment. It does not install software, manage service lifecycles, or broker credentials.

This boundary is deliberate. The routing layer must be lightweight, focused, and trustworthy. The moment it takes responsibility for installing OpenClaw or managing GitHub OAuth flows, it becomes a different kind of tool -- one with a different security model, different dependencies, and different failure modes.

But OrgLoop *should* make the path to a fully operational environment as obvious and friction-free as possible. The way it does this: **declare the full truth in a machine-readable contract, and let specialized tools act on it.**

## What OrgLoop Does

| Capability | How |
|---|---|
| Declare full dependency graph | Project config (`orgloop.yaml`) + connector setup metadata |
| Validate environment | `orgloop doctor` reports what's present, missing, degraded |
| Run in degraded mode | Queue events when actors are unavailable, deliver when they come online |
| Surface connector guidance | Connector `setup` metadata provides per-variable help text, URLs, and commands |
| Machine-readable diagnostics | `orgloop doctor --json` for automation and external tools |
| Non-interactive installation | `orgloop init --no-interactive` for scripted project setup |
| Route events | The core function: source events matched to routes, transformed, delivered to actors |
| Observe everything | Loggers capture every pipeline phase as a first-class primitive |

## What OrgLoop Does Not Do

| Capability | Why Not | Who Does It |
|---|---|---|
| Install software (brew, apt, docker) | Different security model, platform-specific | [orgctl](/vision/orgctl/) or user |
| Manage service lifecycles (start/stop/health) | OrgLoop is a daemon, not an init system | orgctl or system tools |
| Run OAuth flows | Requires temp HTTP server, browser integration | Connector maturity (Stage 3) or orgctl |
| Generate/distribute shared tokens | Cross-system credential coordination | orgctl |
| Store credentials in OS keychain | Platform-specific, security-critical | orgctl |
| Create resources in external systems | OrgLoop configures itself, not others | External system's own CLI/UI |

The guiding principle: OrgLoop routes events. It never installs software, brokers credentials, or manages services. Those responsibilities belong to tools with the appropriate trust boundaries.

## The Shared Contract: Project Config and Connector Setup Metadata

The project config (`orgloop.yaml`) and connector setup metadata together form a contract designed for **multiple consumers**. OrgLoop reads the parts it needs (connectors, routes, transforms). External tools read connector setup metadata for the parts they need (services, credentials, hooks). Same packages, different audiences.

```
          orgloop.yaml + ConnectorRegistration.setup

  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐
  │ connectors  │  │ services     │  │ credentials      │
  │ routes      │  │ install hints│  │ oauth flows      │
  │ transforms  │  │ health checks│  │ cross-system     │
  │ loggers     │  │ hooks        │  │ keychain storage │
  └──────┬──────┘  └──────┬───────┘  └────────┬─────────┘
         │                │                    │
   ┌─────▼─────┐   ┌─────▼──────┐   ┌────────▼────────┐
   │  OrgLoop  │   │  orgctl    │   │ Cred. Broker    │
   │  (router) │   │  (sister   │   │ (connector      │
   │           │   │  project)  │   │  maturity or    │
   │ Reads:    │   │            │   │  sister project)│
   │ connectors│   │ Reads:     │   │                 │
   │ routes    │   │ services   │   │ Reads:          │
   │ transforms│   │ install    │   │ credentials     │
   │ loggers   │   │ hooks      │   │ oauth           │
   └───────────┘   └────────────┘   └─────────────────┘
```

**Design rule:** OrgLoop functions correctly even if `services`, `credentials`, and `hooks` are entirely absent from connector setup metadata. They are informational for OrgLoop (used by `orgloop doctor` to display guidance), but actionable for external tools.

## Connector Maturity Stages

Connectors evolve through maturity stages. Each stage adds optional capabilities that OrgLoop and external tools can leverage. Connector authors control the pace.

### Stage 1: Functional

The minimum viable connector. Implements `source` or `target`. Config accepts env var references. It works.

```typescript
register(): ConnectorRegistration {
  return { id: 'github', source: GitHubSource };
}
```

At this stage, `orgloop doctor` can only check whether the connector package is installed. Users must know what environment variables are needed by reading documentation.

### Stage 2: Discoverable

Adds `setup` metadata -- environment variable descriptions, help URLs, and optionally service detection and credential validation.

```typescript
register(): ConnectorRegistration {
  return {
    id: 'github',
    source: GitHubSource,
    setup: {
      env_vars: [
        {
          name: 'GITHUB_TOKEN',
          description: 'Personal access token (repo scope)',
          help_url: 'https://github.com/settings/tokens/new?scopes=repo'
        }
      ],
    },
    credential_validators: {
      GITHUB_TOKEN: { validate: async (token) => { /* test API call */ } },
    },
  };
}
```

At this stage, `orgloop env` shows which variables are set and which are missing, with actionable guidance for each one. `orgloop doctor` can validate that credentials actually work, not just that they exist.

### Stage 3: Self-Service

Adds `credential_acquirers` -- the connector can obtain credentials itself through OAuth flows or API calls.

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

At this stage, `orgloop setup` can walk the user through credential acquisition without leaving the terminal. No manual token pasting.

Each stage is backward-compatible. A Stage 1 connector works fine -- it just provides less guidance. `orgloop doctor` and external tools gracefully degrade based on what the connector reports.

## The Orchestrator Vision

A sister project, [orgctl](/vision/orgctl/), reads the same project config and connector setup metadata, and handles what OrgLoop deliberately does not: service installation, credential brokering, cross-system configuration.

```bash
# The vision
orgctl bootstrap --project ./my-org --github-repo my-org/my-repo

# orgctl does:
# 1. npm install (connector deps from package.json)
# 2. Install services (brew install openclaw && openclaw start)
# 3. Wait for health checks
# 4. Broker credentials (GitHub OAuth, OpenClaw token generation)
# 5. Write .env
# 6. orgloop start
```

OrgLoop does not know or care that orgctl exists. It reads the same YAML it always reads. The orchestrator is a consumer of OrgLoop's stable interfaces.

## Interface Commitments

These interfaces are designed for external consumption and should be treated as stable:

1. **Project config schema** -- Published as JSON Schema from `@orgloop/sdk`. External tools validate against it.
2. **`orgloop doctor --json`** -- Machine-readable environment diagnostics. The API between OrgLoop and any orchestration tool.
3. **`--no-interactive` flags** -- On `orgloop init` and `orgloop setup`. Enables scripted and automated installation.
4. **`ConnectorRegistration` extensions** -- `setup`, `service_detector`, `credential_validators`, and future `credential_acquirers`. The building blocks for progressive DX.

## DX Progression

The path from today to the vision is incremental. Each stage is reachable without the previous one.

**Today:**
```
orgloop init -> orgloop env (shows what's needed) -> manually fix -> orgloop start
```
User does manual service installation and credential creation. OrgLoop guides honestly.

**Tomorrow (connector maturity):**
```
orgloop init -> orgloop setup (OAuth prompts, auto-detection) -> orgloop start
```
Connectors at Stage 2-3 handle credential acquisition. No manual token pasting.

**Vision (orchestrator):**
```
orgctl bootstrap --project ./my-org -> done
```
One command. Blank machine to running organization.

The orchestrator does not require Stage 3 connectors (it can install services and prompt for tokens). Stage 3 connectors do not require the orchestrator (they work in `orgloop setup`). The pieces compose independently.
