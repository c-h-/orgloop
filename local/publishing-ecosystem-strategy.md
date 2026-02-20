## 2. Publishing & Ecosystem Strategy

### 2.1 GitHub Publishing Strategy

**Decision: Personal repo initially, with a path to a GitHub org.**

#### Option A: Personal Repo (`orgloop/orgloop`)

Pros:
- **Profile visibility.** Pinned repos on a personal profile are the first thing people see. If OrgLoop is Charlie's highest-profile open source project, it's immediately visible to anyone who looks at the GitHub profile.
- **Personal brand association.** "Charlie built OrgLoop" is a clearer narrative than "the OrgLoop org published OrgLoop." For a founding engineer establishing credibility, personal attribution matters.
- **Simpler.** One GitHub account, one set of permissions, no org administration overhead. Fewer moving parts at launch.
- **Credibility signal.** A real person's name on a project signals conviction. Compare: Sindre Sorhus publishes everything under `sindresorhus/*` — the personal brand IS the trust signal.

Cons:
- **Bus factor.** The repo lives under one account. If the project grows, contributors may want org-level governance.
- **Team scaling.** Adding maintainers to a personal repo is possible but less structured than org teams.
- **Professional perception.** Some enterprise evaluators prefer seeing an org (signals "project" vs "hobby").

#### Option B: GitHub Org (`orgloop/orgloop`)

Pros:
- **Project identity.** The project has its own namespace from day one. Looks "official."
- **Team management.** GitHub org teams with granular permissions. Easier to add/remove maintainers.
- **Multi-repo future.** If OrgLoop grows to multiple repos (docs site, community connectors registry, etc.), an org provides a natural home.

Cons:
- **Discoverability.** Org repos don't appear on personal profiles by default. Charlie would need to pin it and link to it separately.
- **Premature structure.** An org with one member and one repo is overhead without benefit.
- **Split identity.** Contributions to org repos don't show as prominently in personal contribution graphs.

#### Recommendation

**Start with `orgloop/orgloop` (personal repo).** The profile visibility, personal brand association, and simplicity outweigh the governance benefits of an org at this stage. The project needs attention and credibility more than it needs structure.

**Migration path to org:**
1. When the project has its first external maintainer (not just contributor — someone with merge rights), create the `orgloop` GitHub org.
2. Transfer the repo (`orgloop/orgloop` → `orgloop/orgloop`). GitHub handles redirects automatically.
3. Charlie remains org owner. Add maintainers as org members with appropriate team permissions.
4. Pin the org repo on Charlie's personal profile so visibility is maintained.

**Trigger:** "When someone other than me needs merge access" — that's when the org becomes worth the overhead.

### 2.2 npm Namespace Strategy

**Claim the `@orgloop` npm scope immediately.** This is the single most important ecosystem land-grab.

#### Steps to Claim

```bash
# 1. Create an npm org (free for public packages)
npm org create orgloop

# 2. Verify — this reserves the @orgloop/* scope
npm whoami --scope=@orgloop

# 3. Publish the first package to establish the scope
cd packages/core
npm publish --access public
```

The npm org is free for public packages. Charlie is the sole owner. Add maintainers later as needed.

#### Package Naming Convention

**First-party packages** (published by Charlie under `@orgloop` scope):

| Package | Description |
|---------|-------------|
| `@orgloop/core` | Runtime engine (library-first — see [API/SDK Runtime Modes](#9-apisdk-runtime-modes)) |
| `@orgloop/cli` | Command-line interface |
| `@orgloop/sdk` | Plugin development kit (interfaces, test harness) |
| `@orgloop/server` | HTTP API server |
| `@orgloop/connector-github` | GitHub connector |
| `@orgloop/connector-linear` | Linear connector |
| `@orgloop/connector-openclaw` | OpenClaw connector |
| `@orgloop/connector-claude-code` | Claude Code connector |
| `@orgloop/connector-webhook` | Generic webhook connector |
| `@orgloop/transform-filter` | jq-based filter transform |
| `@orgloop/transform-dedup` | Deduplication transform |
| `@orgloop/transform-injection-scanner` | Prompt injection scanner |
| `@orgloop/logger-file` | File logger (JSONL) |
| `@orgloop/logger-console` | Console logger |

**Community packages** (published by anyone, no approval needed):

| Convention | Example |
|-----------|---------|
| `orgloop-connector-*` | `orgloop-connector-jira`, `orgloop-connector-pagerduty` |
| `orgloop-transform-*` | `orgloop-transform-slack-format`, `orgloop-transform-enrich-user` |
| `orgloop-logger-*` | `orgloop-logger-datadog`, `orgloop-logger-splunk` |

Anyone can `npm publish orgloop-connector-whatever` at any time. No approval, no registry, no bottleneck. Users can `npm install` it immediately and reference it in their `orgloop.yaml`.

**First-party blessing** happens later: if a community package is high-quality and widely used, it can be adopted into the `@orgloop/*` scope. This is a quality signal, not a gate. The community package continues to work regardless.

**Analogy:** Terraform's `hashicorp/aws` (first-party) vs. community providers. HashiCorp doesn't gatekeep who can write a Terraform provider. Anyone can publish one. The `hashicorp/*` namespace just means "we built and maintain this one."

### 2.3 Domain & Namespace Reservation

**Reserve early:**
- [x] npm org: `@orgloop` (claim immediately)
- [ ] Domain: `orgloop.dev` (for docs, registry, marketing)
- [ ] GitHub: `orgloop` org (reserve the name even if not using it yet — create the org, just don't transfer the repo until the trigger is met)
- [ ] Twitter/X: `@orgloop` (if available)

### 2.4 Design Principle: Zero Bottleneck to Adoption

**This is a core design principle.** The ecosystem must grow without Charlie (or any central authority) being a bottleneck.

#### The Principle

Anyone can extend OrgLoop — publish a connector, transform, or logger — without asking permission, registering in a directory, or waiting for approval. The runtime loads any package that implements the interface. Period.

#### How It Works

1. **Convention-based naming.** Community packages follow the naming convention:
   - `orgloop-connector-*` — connectors
   - `orgloop-transform-*` — transforms
   - `orgloop-logger-*` — loggers
   
   This makes packages discoverable via npm search: `npm search orgloop-connector`.

2. **Interface-based loading.** The runtime doesn't check a registry or allowlist. It `import()`s whatever package the user specifies in `orgloop.yaml`. If the package exports a valid registration function implementing the `@orgloop/sdk` interfaces, it works. If it doesn't, the runtime gives a clear error at `orgloop validate` time.

3. **No registry gatekeeping.** There is no central registry that must approve or list a plugin for it to be usable. npm IS the registry. Publish → install → use. Done.

4. **First-party blessing is a quality signal, not a requirement.** The `@orgloop/*` scope means "maintained by the core team, tested against every release, guaranteed compatible." Community packages work just as well — they just manage their own compatibility.

5. **SDK makes it easy.** `@orgloop/sdk` provides:
   - TypeScript interfaces to implement
   - A test harness (`orgloop test --connector my-plugin`) that verifies interface compliance
   - Documentation and examples for writing each plugin type
   - A scaffold command (`orgloop add connector my-thing`) that generates boilerplate

#### Ecosystem Model

Think of it as concentric rings:

```
┌─────────────────────────────────────────────┐
│          Community Packages                  │
│  orgloop-connector-*, orgloop-transform-*    │
│  Anyone publishes. No approval.              │
│                                              │
│    ┌─────────────────────────────────────┐   │
│    │      First-Party Packages           │   │
│    │  @orgloop/connector-*, etc.         │   │
│    │  Core team maintains.               │   │
│    │                                     │   │
│    │    ┌─────────────────────────────┐   │   │
│    │    │       Core Runtime          │   │   │
│    │    │  @orgloop/core              │   │   │
│    │    │  @orgloop/sdk               │   │   │
│    │    │  @orgloop/cli               │   │   │
│    │    └─────────────────────────────┘   │   │
│    └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

Community packages can move inward (get blessed) but never need to. Users at the outer ring have the same runtime capabilities as users at the inner ring.

---

