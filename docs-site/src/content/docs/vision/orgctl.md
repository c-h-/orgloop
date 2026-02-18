---
title: "orgctl: Environment Bootstrapping"
description: A sister tool that bridges the gap between installing OrgLoop and having a running organization.
---

## The Problem

The [manifesto](/vision/manifesto/) ends with a compelling demo:

```bash
npm install -g @orgloop/cli
orgloop init --connectors github,linear,openclaw,claude-code
cd my-org && npm install
orgloop start
```

But between `init` and `start`, there is an implicit step: **configure your environment**. You need to install OpenClaw, create a GitHub personal access token, configure Claude Code hooks, set up shared webhook secrets, and write a `.env` file. Each of those has its own setup flow, its own documentation, its own failure modes.

This is where people give up. Not because OrgLoop is hard, but because the "Edit" step between installation and execution is a scattered scavenger hunt across half a dozen platforms.

**orgctl** eliminates the "Edit" step.

```bash
orgctl bootstrap --project ./my-org --github-repo my-org/my-repo
# Blank machine -> running autonomous engineering org
```

## Why a Separate Project

OrgLoop is an event routing layer. Its value comes from being lightweight, focused, and trustworthy. Adding service management, OAuth flows, and credential brokering would:

- **Expand its security surface** -- OrgLoop reads env vars; orgctl installs software and manages secrets
- **Add platform dependencies** -- Homebrew, Docker, OS keychain APIs, browser automation
- **Change its runtime model** -- OrgLoop is a long-running daemon; orgctl is a one-shot setup tool
- **Muddy its identity** -- "the reliable system around unreliable actors" becomes "also your package manager"

orgctl has a different security model, different dependencies, and a different lifecycle. It deserves its own project, its own release cadence, and its own trust boundary.

## What orgctl Does

### The Bootstrap Sequence

`orgctl bootstrap` executes a deterministic 9-step sequence:

1. **Read project config** -- Parse `orgloop.yaml` and resolve connector package dependencies from `package.json`
2. **Install packages** -- `npm install` to resolve all connector, transform, and logger dependencies
3. **Check environment** -- For each connector's setup metadata, detect what is already present
4. **Install services** -- For each missing service, install via the connector's `install` hints (brew, apt, docker)
5. **Wait for health** -- Poll each service's health endpoint until ready
6. **Broker credentials** -- For each missing credential:
   - If `oauth` block: open browser, run OAuth flow, capture token
   - If `create_api` block: call the service's API to generate a token
   - If `cross_system` block: generate shared token, configure both sides
   - Otherwise: prompt the user with `description` and `help_url`
7. **Store credentials** -- Write to `.env` file and optionally OS keychain
8. **Configure hooks** -- Write hook files per connector setup entries (e.g., Claude Code stop hooks)
9. **Apply** -- `orgloop start`

### Supporting Commands

```
orgctl bootstrap --project <path>     Full environment bootstrap
orgctl check --project <path>         Pre-flight only — show what's needed without acting
orgctl credentials --project <path>   Credential brokering only (services already running)
orgctl services --project <path>      Service installation only
orgctl teardown --project <path>      Remove services and credentials installed by bootstrap
orgctl version                        Print version info
```

### Flags

```
--non-interactive       No prompts — fail if any credential can't be acquired automatically
--skip-services         Don't install services (user manages them)
--skip-credentials      Don't broker credentials (user sets env vars manually)
--env-file <path>       Path to .env file (default: ./.env)
--keychain              Store credentials in OS keychain instead of .env
--docker                Prefer Docker for service installation
--dry-run               Show what would be done without doing it
```

## What orgctl Does Not Do

- **Run as a daemon.** orgctl is a one-shot setup tool. It runs, configures your environment, and exits.
- **Manage OrgLoop's runtime.** Starting, stopping, and restarting OrgLoop is the `orgloop` CLI's job.
- **Route events.** That is OrgLoop's entire purpose.
- **Replace `orgloop doctor`.** orgctl consumes `orgloop doctor --json` output to verify the environment after bootstrap.
- **Monitor services after installation.** No health checks, no restart-on-crash. System service managers handle that.

## Interfaces Consumed

orgctl is a **consumer** of OrgLoop's published interfaces. It has no private API access.

### Project Config and Connector Setup Metadata

orgctl reads `orgloop.yaml` to discover which connectors are in use, then inspects each connector's `ConnectorRegistration.setup` metadata for service and credential requirements:

```yaml
# orgloop.yaml — orgctl reads this to discover connectors
connectors:
  - connectors/github.yaml
  - connectors/openclaw.yaml
```

```typescript
// Connector setup metadata — orgctl reads this for bootstrap guidance
register(): ConnectorRegistration {
  return {
    id: 'github',
    source: GitHubSource,
    setup: {
      env_vars: [
        {
          name: 'GITHUB_TOKEN',
          description: 'Personal access token (repo scope)',
          help_url: 'https://github.com/settings/tokens/new?scopes=repo,read:org'
        }
      ],
      services: [
        {
          name: 'openclaw',
          detect: { http: 'http://127.0.0.1:18789/health' },
          install: {
            brew: 'openclaw',
            docker: { image: 'ghcr.io/openclaw/openclaw:latest', ports: ['18789:18789'] },
            manual: 'https://docs.openclaw.dev/install'
          }
        }
      ]
    }
  };
}
```

### `orgloop doctor --json`

orgctl calls `orgloop doctor --json` to verify the environment state after bootstrap:

```json
{
  "status": "ok",
  "checks": [
    { "category": "package", "name": "@orgloop/connector-github", "status": "ok" },
    { "category": "service", "name": "openclaw", "status": "ok", "version": "2.1.0" },
    { "category": "credential", "name": "GITHUB_TOKEN", "status": "ok" }
  ]
}
```

## The Boundary

```
          orgctl's domain                  OrgLoop's domain

  Install services ─────────────────
  Broker credentials ───────────────
  Write .env files ─────────────────
  Configure hooks ──────────────────
  Install npm packages ─────────────
  Call orgloop start ─────────────── ── Engine startup
                                     ── Event routing
                                     ── Transform pipeline
                                     ── Actor delivery
                                     ── Logging & observability
```

orgctl's job is done when `orgloop start` starts successfully. After that, OrgLoop owns the runtime.

## Implementation Status

orgctl is **designed but not yet built**. The specification is complete (see the full [RFP](https://github.com/c-h-/orgloop/blob/main/docs/rfp-orgctl.md) in the OrgLoop repository). Implementation begins after OrgLoop's connector setup metadata schema stabilizes.

### Planned Phases

1. **`orgctl check`** -- Pre-flight only. Reads project config and connector setup metadata, checks environment, reports what is needed. No installation, no credential brokering. Validates that the schema works.
2. **`orgctl credentials`** -- Credential brokering. Prompt-based collection with validation, `.env` file generation, OAuth flows for connectors that support them.
3. **`orgctl services`** -- Service installation. Homebrew/apt/Docker support. Health check polling. Detect-before-install.
4. **`orgctl bootstrap`** -- The full flow. Compose phases 1-3 with OrgLoop CLI invocation.

### Platform Support

| Platform | Package Manager | Keychain | Priority |
|---|---|---|---|
| macOS | Homebrew | macOS Keychain | P0 |
| Linux (Debian/Ubuntu) | apt | libsecret | P1 |
| Linux (other) | Manual + Docker | libsecret | P2 |
| Windows/WSL | apt (WSL) | Windows Credential Manager | P3 |

## The Demo Vision

This is the one-click promise that OrgLoop and orgctl together deliver:

```bash
npm install -g @orgloop/cli orgctl
orgloop init --connectors github,linear,openclaw,claude-code
orgctl bootstrap --project ./my-org --github-repo my-org/my-repo
# Done. Your engineering organization is running.
```

OrgLoop is the routing layer that makes it run. orgctl is the bootstrapper that gets you there.

## Contributing

orgctl will be a separate open-source project in the `orgloop` GitHub organization. It shares types with OrgLoop by depending on `@orgloop/sdk` for manifest schema definitions.

If you are interested in contributing to orgctl -- particularly around service detection, credential brokering, or platform-specific package management -- watch the [c-h-/orgloop](https://github.com/c-h-/orgloop) repository for the announcement of the orgctl project.

The technical starting point: read the [project config schema](/reference/config-schema/) and the [scope boundaries](/vision/scope-boundaries/) that define the interface contract between OrgLoop and external tools.
