---
title: "Plugin System"
description: "Installation methods, connector discovery and loading, setup metadata, and cross-platform support."
---

### 7.1 Installation Methods

**Primary: npm (global install)**
```bash
npm install -g @orgloop/cli
# or
pnpm add -g @orgloop/cli
```

This installs the `orgloop` binary. Requires Node.js >= 22.

**Secondary: Homebrew (macOS/Linux)**
```bash
brew install orgloop
```

The Homebrew formula bundles Node.js via Single Executable Application (SEA) — no external Node dependency.

**Tertiary: Docker**
```bash
docker run -v $(pwd):/config ghcr.io/c-h-/orgloop start
```

For server deployments where OrgLoop runs as a daemon.

**Future: curl installer**
```bash
curl -fsSL https://get.orgloop.dev | bash
```

Downloads the SEA binary for the detected platform. Yes, `curl | bash` is ironic given our security posture — but it's what developers expect. The script is auditable and checksummed.

### 7.2 Connector Installation

**Bundled connectors (first-party):**

The `@orgloop/cli` package includes a "batteries-included" set of common connectors:
- `@orgloop/connector-github`
- `@orgloop/connector-webhook`

Additional first-party connectors are installed separately:
```bash
npm install @orgloop/connector-linear
npm install @orgloop/connector-openclaw
npm install @orgloop/connector-claude-code
npm install @orgloop/connector-cron
```

Or via the CLI:
```bash
orgloop add connector linear
# → runs: npm install @orgloop/connector-linear
# → adds to orgloop.yaml connectors list
```

**Community connectors:**
```bash
npm install orgloop-connector-jira
orgloop add connector jira --package orgloop-connector-jira
```

No approval needed. If it implements the interface, it works. See [Zero Bottleneck to Adoption](#24-design-principle-zero-bottleneck-to-adoption).

### 7.3 Plugin Discovery & Loading

**Runtime plugin loading** (not compile-time).

When `orgloop start` starts:
1. Read `orgloop.yaml` -> get list of connector YAML files (file paths, not package names)
2. Load each ConnectorGroup YAML -> collect source/actor definitions with their `connector` package refs
3. The CLI's `resolveConnectors()` function collects unique connector package names, `await import()`s each, and calls its default export (the registration function):

```typescript
// connectors/github/src/index.ts
import { ConnectorRegistration } from '@orgloop/sdk';
import { GitHubSource } from './source';

export default function register(): ConnectorRegistration {
  return {
    id: 'github',
    source: GitHubSource,
    setup: {
      env_vars: ['GITHUB_TOKEN'],
    },
  };
}
```

4. For each source/actor in config, `resolveConnectors()` instantiates `new reg.source()` or `new reg.target()`, building `sources: Map<string, SourceConnector>` and `actors: Map<string, ActorConnector>`
5. These Maps are passed to the runtime via `runtime.loadModule()` (an internal API). The `OrgLoop` wrapper class accepts `new OrgLoop(config, { sources, actors })` for programmatic use -- it creates a `Runtime` internally.
6. If a connector import fails, the CLI suggests `npm install <package>` to the user

**Plugin resolution order:**
1. Project `node_modules/` (packages installed in the project directory -- preferred)
2. CLI `node_modules/` (packages bundled with or installed alongside `@orgloop/cli` -- fallback)
3. Built-in (bundled with CLI)

### 7.4 Connector Setup Metadata

Connectors optionally export setup metadata that the CLI uses for onboarding guidance. This follows a **progressive maturity** model — connectors start minimal and add capabilities over time.

#### Environment Variable Descriptions

The `setup.env_vars` field provides per-variable guidance rendered by `orgloop env`, `orgloop init`, and error messages:

```typescript
setup: {
  env_vars: [
    {
      name: 'GITHUB_TOKEN',
      description: 'Personal access token with repo scope',
      help_url: 'https://github.com/settings/tokens/new?scopes=repo,read:org',
    },
    {
      name: 'GITHUB_REPO',
      description: 'Repository in org/repo format',
    },
  ],
}
```

When a variable is unset, the CLI renders:
```
  ✗ GITHUB_TOKEN  — Personal access token with repo scope
    → https://github.com/settings/tokens/new?scopes=repo,read:org
```

#### Service Detection (Stage 2)

Connectors that depend on external services can export a `ServiceDetector`:

```typescript
interface ServiceDetector {
  detect(): Promise<{
    running: boolean;
    version?: string;
    endpoint?: string;
    details?: Record<string, unknown>;
  }>;
}
```

Used by `orgloop doctor` to report service availability. External tools (see [orgctl RFP](https://orgloop.ai/vision/orgctl/)) can also consume this interface.

#### Credential Validation (Stage 2)

Connectors can validate that a credential actually works, not just that the env var is set:

```typescript
interface CredentialValidator {
  validate(value: string): Promise<{
    valid: boolean;
    identity?: string;     // e.g., "user: @alice"
    scopes?: string[];     // e.g., ["repo", "read:org"]
    error?: string;
  }>;
}
```

Used by `orgloop doctor` and `orgloop setup` for deep environment validation.

#### Credential Acquisition (Stage 3, future)

Connectors may eventually export `CredentialAcquirer` for OAuth flows and API-based token generation. See [Scope Boundaries](./scope-boundaries/) for the maturity model.

#### Extended ConnectorRegistration

```typescript
interface ConnectorRegistration {
  id: string;
  source?: new () => SourceConnector;
  target?: new () => ActorConnector;
  configSchema?: Record<string, unknown>;
  setup?: ConnectorSetup;

  // Stage 2: discoverable
  service_detector?: ServiceDetector;
  credential_validators?: Record<string, CredentialValidator>;

  // Stage 3: self-service (future)
  // credential_acquirers?: Record<string, CredentialAcquirer>;
}

interface ConnectorSetup {
  env_vars?: (string | EnvVarDefinition)[];
  integrations?: ConnectorIntegration[];
}

interface EnvVarDefinition {
  name: string;
  description: string;
  help_url?: string;
  help_command?: string;
  required?: boolean;
}
```

### 7.5 Cross-Platform Support

| Platform | MVP | v1.0 |
|----------|-----|------|
| macOS (Apple Silicon) | Yes | Yes |
| macOS (Intel) | Yes | Yes |
| Linux (x64) | Yes | Yes |
| Linux (ARM64) | Yes | Yes |
| Windows | No | Best-effort |

Windows is out of MVP scope because:
- Shell script transforms assume POSIX (`#!/bin/bash`, pipes, etc.)
- Our team and early users are macOS/Linux
- WSL2 is a viable escape hatch for Windows users
