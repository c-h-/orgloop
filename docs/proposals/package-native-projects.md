# Package-Native Projects

**Status:** Proposal
**Date:** 2026-02-17

OrgLoop projects should feel like normal Node.js projects. Dependencies managed with standard package managers, not bespoke CLI commands. This proposal audits the current state, evaluates options, and recommends a path forward.

---

## 1. Current State Audit

### 1.1 How Projects Work Today

An OrgLoop project is a directory containing:

```
my-org/
├── package.json            # Dependencies: @orgloop/core, connectors, transforms, loggers
├── orgloop.yaml            # Top-level config: references connector/transform/logger/route files
├── connectors/
│   ├── github.yaml         # connector: "@orgloop/connector-github" + config
│   └── linear.yaml
├── transforms/
│   └── filter.yaml
├── routes/
│   └── pr-review.yaml      # Auto-discovered from routes/ dir
├── loggers/
│   └── file.yaml
├── sops/                    # Launch prompt files
│   └── example.md
└── node_modules/           # Standard npm dependencies
```

Two files declare dependencies:

| File | Declares | Who writes it | Who reads it |
|------|----------|---------------|--------------|
| `package.json` | npm packages (`@orgloop/connector-github`, etc.) | `orgloop init` auto-generates; user can edit | `npm install`, Node resolution |
| `orgloop.yaml` → `connectors/*.yaml` | Connector package names as `connector:` field values | `orgloop init` scaffolds; `orgloop add module` appends | CLI at `orgloop start` time |

### 1.2 The Resolution Chain

```
orgloop start
  → loadCliConfig() reads orgloop.yaml + referenced YAML files
  → Collects connector/transform/logger package names from YAML
  → createProjectImport(projectDir)
    → tries project node_modules via createRequire first
    → falls back to CLI's own node_modules (monorepo/workspace support)
  → Dynamic import → package exports register() → ConnectorRegistration
  → Runtime receives pre-instantiated source/actor/transform/logger Maps
```

This flow is **fundamentally sound** and matches how ESLint, Vite, and Gatsby handle plugins: users install packages with npm, config references them by name, the tool resolves at startup.

### 1.3 File-by-File Audit

#### `packages/cli/src/commands/init.ts` — Project Scaffolding

**What it does:** Interactive wizard scaffolds a complete project with selected connectors. Creates directory structure, YAML files, `package.json`, and `.env.example` with progressive delight (Level 3: env var status with help URLs).

**How it handles deps:** Hardcoded `CONNECTOR_PACKAGES` map (`github` → `@orgloop/connector-github`). Generates `package.json` with `"latest"` for all deps.

**Friction points:**
- Hardcoded connector list — adding a first-party connector requires editing CLI source code
- `"latest"` versions — not reproducible, no lockfile guarantee
- No dynamic discovery of available connectors
- Always bundles `@orgloop/logger-file` even if user wants console-only

#### `packages/cli/src/commands/add.ts` — Adding Components

**What it does:** Subcommands scaffold connectors, transforms, routes, loggers (generates YAML stubs), and modules (runs `npm install` + loads manifest + copies files + merges into orgloop.yaml).

**The `connector`/`transform`/`route`/`logger` subcommands are good** — they scaffold YAML files and print a hint about what to do next. Pure scaffolding, no dependency management.

**The `module` subcommand is the problem:**
- Runs `execSync('npm install <name>')` with hardcoded 60s timeout and piped stdio
- Users can't use their preferred package manager (pnpm, yarn, bun)
- No progress visible to user during install
- No pre-validation that the package is actually an OrgLoop module
- Module manifest loading, template expansion, file copying — ~200 lines of bespoke dependency management

#### `packages/cli/src/module-resolver.ts` — Module Resolution

**What it does:** Resolves module package paths, loads `orgloop-module.yaml` manifests, validates against AJV schema, expands route templates with `{{ param }}` syntax, aggregates modules into concrete routes.

**This is ~180 lines of infrastructure** for a feature with no known production users. The module concept (bundled workflows) is valuable, but the implementation adds a parallel resolution system alongside the standard connector flow.

#### `packages/cli/src/project-import.ts` — Package Resolution

**What it does:** `createProjectImport()` returns an async function that resolves packages from the project's `node_modules` first, then falls back to CLI's own `node_modules`.

**This is the right pattern.** Two-level fallback enables monorepo development (workspace links) while keeping user projects self-contained.

**One issue:** Fallback to CLI-bundled packages is invisible. Users don't know whether they're running their project-local version or the CLI's bundled copy.

#### `packages/cli/src/commands/start.ts` — Startup & Plugin Loading

**What it does:** Creates `projectImport` function, resolves connectors/transforms/loggers via dynamic import, creates Runtime, loads config as a module.

**Critical bug:** Transforms and loggers fail-open (warn and continue) while connectors fail-closed (abort startup). A missing transform means routes silently don't filter/enrich events — a dangerous mode that users won't notice until they investigate why events are being delivered unfiltered.

### 1.4 Examples Have No package.json

The `examples/` directory contains orgloop.yaml files with connector references but no `package.json`. Users who copy an example must reverse-engineer which npm packages to install by reading YAML files.

### 1.5 What Works Well

- **Project-relative resolution via `createProjectImport`** — the right pattern
- **Modules as config-time expansion** — engine never sees modules, only concrete routes
- **Env var progressive delight** in `orgloop init` — shows ✓/✗ status per var with help URLs
- **The plugin `register()` pattern** — standard and well-understood
- **`resolveConnectors()` error messages** — includes "run `npm install`" hints
- **YAML split-file model** — connectors/, routes/, transforms/, loggers/ directories enable organizational clarity

### 1.6 Summary of Friction

| Friction | Impact | Cause |
|----------|--------|-------|
| `orgloop add module` wraps `npm install` | Bespoke dep management | Module system design |
| `"latest"` in generated package.json | Unreproducible builds | init.ts hardcoding |
| Transforms/loggers fail silently at startup | Silent data loss | Inconsistent error handling in start.ts |
| No pre-flight dep validation | Runtime import failures | Missing validation step |
| CLI fallback resolution is invisible | Wrong version could run | No logging in project-import.ts |
| Hardcoded connector list in init.ts | Can't add first-party connectors without CLI release | Static mapping |
| Examples lack package.json | Users can't clone-and-run | Missing files |
| YAML and package.json can disagree | Silent misconfiguration | No cross-validation |

---

## 2. How the Node Ecosystem Does It

### The Universal Pattern

Every major Node tool has converged on the same approach:

| Tool | Config Format | Plugin Reference | Install | Discovery |
|------|--------------|------------------|---------|-----------|
| ESLint (flat config) | JS | Explicit import | `npm install` | None |
| Vite | JS | Explicit import | `npm install` | None |
| Tailwind CSS | JS | Explicit import | `npm install` | None |
| Prettier | JSON/YAML | String (passed to `import()`) | `npm install` | None |
| Storybook | JS | String + CLI `add` helper | `npm install` | None |
| Gatsby | JS | String (`resolve` field) | `npm install` | None |
| Turbo | JSON | Reads `package.json` deps | `npm install` | None |

**Key insight: No tool auto-discovers plugins from node_modules.** ESLint explicitly moved *away* from convention-based discovery in v9 (flat config) because implicit resolution caused debugging nightmares. The industry consensus (2024-2026) is: explicit over implicit.

### What Developers Love

- **Explicit imports** (ESLint, Vite) — IDE autocomplete, type checking, click-to-definition
- **CLI `add` helpers** (Storybook) — scaffolds config, *prints* the install command, doesn't hide it
- **String references** (Prettier, Gatsby) — works in non-JS config formats (JSON, YAML)
- **Naming conventions** for discoverability — `eslint-plugin-*`, `vite-plugin-*`, `gatsby-plugin-*` — but for npm search, not runtime behavior
- **Early validation** — clear errors when packages are missing

### What Developers Hate

- **Two-step setup without guidance** — install package, *then* manually find and edit config
- **Silent failures** — plugin not declared = plugin not loaded, no warning
- **Bespoke install commands** — tools that wrap npm with their own installer
- **Breaking changes across plugin API versions** — Webpack's history

### Where OrgLoop Fits

OrgLoop's connector flow (YAML string references resolved via `createRequire`) matches the **Prettier/Gatsby pattern** — string references in a non-JS config format, resolved at startup. This is the right pattern for a YAML-based config.

The module system (`orgloop add module` running `npm install`) is the deviation. No comparable tool does this.

---

## 3. Design Principles

1. **Standard tools for standard operations.** `npm install` (or pnpm/yarn/bun) for dependency management. The CLI never installs packages.
2. **Explicit dependencies.** If YAML references `@orgloop/connector-github`, it must be in `package.json`. Validate this.
3. **No magic discovery.** Don't scan `node_modules` for OrgLoop plugins. Explicit beats implicit.
4. **Single source of truth per concern.** `package.json` owns what's installed. YAML owns how it's configured. Neither duplicates the other.
5. **Scaffolding ≠ dependency management.** CLI can generate YAML files and suggest install commands, but shouldn't execute them.
6. **Fail-closed by default.** If a referenced package isn't available, startup fails with an actionable error. Never silently degrade.
7. **Portable and publishable.** An OrgLoop project should work anywhere that can `npm install` its `package.json`. `git clone && npm install && orgloop start`.

---

## 4. Options

### Option A: Minimal — Remove Module Wrapper, Keep Everything Else

**Strip the `orgloop add module` command. Add pre-flight validation. Fix fail-open plugins. Document the standard npm workflow.**

Changes:
1. Remove `orgloop add module` subcommand
2. Add pre-flight validation in `orgloop doctor` and `orgloop start`: check YAML package references against `package.json` deps
3. Fix transforms/loggers to fail-closed (error, not warning) when packages are missing
4. Update `orgloop init` to use `^0.1.8` ranges instead of `"latest"`
5. Add `package.json` to all examples
6. Document canonical workflow: `npm install` → `orgloop add connector` (scaffold only) → `orgloop start`

What stays the same:
- `orgloop init` still generates `package.json` with deps
- YAML files still reference connector packages by name
- `orgloop add connector/transform/route/logger` still scaffolds YAML
- Resolution via `createProjectImport` unchanged

Canonical workflow:

```bash
orgloop init                                    # Scaffold project with package.json
npm install                                     # Standard package manager
# Later, adding a new connector:
npm install @orgloop/connector-slack            # Standard package manager
orgloop add connector slack                     # Scaffolds YAML (does NOT install)
orgloop doctor                                  # Validates deps + env vars
orgloop start                                   # Resolves from node_modules
```

**Pros:**
- Smallest change surface (~2 days)
- Existing projects keep working unchanged
- Removes unused code (~400 LOC module system)
- Fixes real bugs (fail-open transforms, `"latest"` versions)
- Aligns with ecosystem consensus

**Cons:**
- Loses the module abstraction (bundled workflows)
- Still has hardcoded connector list in init.ts
- Two-step for new connectors: `npm install` then `orgloop add connector`

**Effort:** ~2 days.

### Option B: Full Auto-Discovery from node_modules

**Connectors auto-discovered from installed packages by naming convention.**

Any package matching `@orgloop/connector-*` or `orgloop-connector-*` in `package.json` gets auto-imported at startup. YAML becomes pure configuration — no package references:

```yaml
# Before (current):
sources:
  - id: github
    connector: "@orgloop/connector-github"   # ← explicit package name
    config:
      repo: "${GITHUB_REPO}"

# After (Option B):
sources:
  - id: github
    type: github                              # ← resolved by convention
    config:
      repo: "${GITHUB_REPO}"
```

**Pros:**
- Clean UX: `npm install @orgloop/connector-github` is the only step
- No package name duplication between YAML and package.json
- Adding/removing = standard npm add/remove

**Cons:**
- **Implicit is dangerous.** "Where did this connector come from?" requires checking package.json, not the YAML you're reading.
- **Naming conventions are brittle.** What if a package doesn't follow `orgloop-connector-*`?
- **Transitive dependency leaks.** A package that internally depends on `@orgloop/connector-webhook` would cause it to appear as an "installed" connector.
- **Multi-instance ambiguity.** Two GitHub sources for different repos — how does `type: github` know which registration to use?
- **Against the ecosystem trend.** ESLint moved away from this in v9 because it caused debugging nightmares.
- **Breaking change.** Every existing YAML file needs migration.

**Effort:** ~1.5-2 weeks.

### Option C: Hybrid — Validate YAML Against package.json, Package Manager Detection

**Keep YAML references. Validate against package.json. Detect and delegate to the user's package manager. Make `orgloop add` print install commands.**

Changes:
1. Add pre-flight validation (same as Option A)
2. Fix fail-open plugins (same as Option A)
3. Detect user's package manager (sniff lockfiles: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, else npm)
4. `orgloop add connector github` scaffolds YAML and prints: `Run: pnpm add @orgloop/connector-github`
5. Optional `--install` flag on `orgloop add` delegates to detected package manager
6. Update `orgloop init` to detect package manager and use it in messaging
7. Remove module system (same as Option A)

Canonical workflow:

```bash
orgloop init                                    # Scaffold project
pnpm install                                    # Detected: uses pnpm
# Later:
orgloop add connector slack                     # Scaffolds YAML, prints: pnpm add @orgloop/connector-webhook
orgloop add connector slack --install           # Same + runs pnpm add for you
orgloop doctor                                  # Validates everything
orgloop start
```

**Pros:**
- Respects user's package manager choice
- `--install` flag for convenience without hiding what's happening
- Backward compatible
- Good DX: actionable messages use the right package manager name

**Cons:**
- `--install` flag is complexity that encourages wrapping package managers
- Package manager detection is another moving part to maintain
- Marginal benefit over Option A for significantly more code

**Effort:** ~1-1.5 weeks.

### Option D: YAML-Driven Deps (Sync from YAML to package.json)

**YAML is the source of truth. `orgloop sync` generates/updates package.json from YAML declarations.**

```yaml
sources:
  - id: github
    connector: "@orgloop/connector-github@^0.1.8"  # version hint in YAML
    config:
      repo: "${GITHUB_REPO}"
```

```bash
orgloop sync            # Reads YAML, updates package.json deps
npm install             # Installs what sync declared
```

**Pros:**
- Single source of truth: YAML declares everything
- Version hints visible where connectors are configured
- Familiar to Terraform/Helm users

**Cons:**
- **Fights the Node ecosystem.** package.json is the universal source of truth for Node deps. Making it derived is deeply surprising.
- **Version conflicts.** Two YAML files referencing different versions of the same package.
- **Lock file confusion.** Automatically updating package.json causes lock file churn.
- **Non-standard.** No other Node tool works this way.

**Effort:** ~1.5-2 weeks.

### Option E: JavaScript Config (ESLint Flat Config Pattern)

**Replace YAML with a JavaScript/TypeScript config file with explicit imports.**

```typescript
// orgloop.config.ts
import github from '@orgloop/connector-github';
import filter from '@orgloop/transform-filter';
import fileLogger from '@orgloop/logger-file';

export default defineConfig({
  sources: [
    github({ repo: process.env.GITHUB_REPO!, token: process.env.GITHUB_TOKEN! }),
  ],
  transforms: [filter({ exclude: ['*.bot'] })],
  loggers: [fileLogger({ path: '~/.orgloop/logs/orgloop.log' })],
  routes: [
    { when: { source: 'github', events: ['resource.changed'] }, then: { actor: 'openclaw' } },
  ],
});
```

**Pros:**
- **Explicit imports** — IDE autocomplete, type checking, click-to-definition
- **No resolution ambiguity** — if it imports, it's installed
- **Composable** — spread operators, conditionals, loops, functions
- **Standard Node pattern** — ESLint, Vite, Tailwind all moved here
- **package.json is the only dependency declaration** — zero duplication

**Cons:**
- **Major breaking change.** Every existing YAML project needs migration.
- **Raises the bar.** YAML is approachable for non-developers. JS config requires JavaScript knowledge.
- **Loses YAML split-file model.** Separate connectors/, routes/, transforms/ directories enable organizational clarity that a single JS file doesn't naturally provide.
- **Module template expansion** uses YAML `{{ }}` syntax. JS config needs a different approach.
- **Two config formats during migration.** Supporting both is significant complexity.
- **Wrong timing.** OrgLoop is pre-1.0. The YAML model works. JS config is a v2.0 consideration.

**Effort:** ~3-4 weeks for core + migration tooling.

---

## 5. Recommendation: Option A (Minimal Cleanup)

### Why Option A

**The system already works the right way.** The connector resolution chain (YAML references → createProjectImport → node_modules → register()) is sound and matches ecosystem patterns. The friction comes from the module system layered on top. Removing it and adding validation is the highest-value, lowest-risk change.

### Decision Matrix

| Criterion | A | B | C | D | E |
|-----------|---|---|---|---|---|
| Effort | ~2 days | ~2 weeks | ~1.5 weeks | ~2 weeks | ~4 weeks |
| Breaking changes | None | All YAML | None | Conceptual | All config |
| Ecosystem alignment | High | Low | High | Low | Highest |
| DX improvement | Good | Mixed | Good | Mixed | Best (long-term) |
| Risk | Very low | Medium | Low | Medium | High |
| Addresses core friction | Yes | Partially | Yes | No | Yes |

### Why Not the Others

| Option | Rejection Reason |
|--------|-----------------|
| **B (Auto-discovery)** | ESLint tried this and backed away. Implicit resolution creates debugging nightmares. Transitive dep leaks are a real problem. |
| **C (Hybrid)** | Package manager detection and `--install` flags add complexity for marginal benefit over Option A. If users want convenience, they can alias it. The CLI shouldn't be in the business of wrapping package managers. |
| **D (YAML-driven deps)** | Fights the Node ecosystem. `package.json` is the universal source of truth. Making it derived is non-standard and surprising. |
| **E (JS config)** | Right direction long-term but wrong timing. OrgLoop is pre-1.0 with YAML that works. JS config is a v2.0 consideration when the user base is larger and the API is stable. |

### What About Modules?

The module system (bundled workflows: install one package, get connectors + routes + transforms) is a valuable *concept*. But the current implementation (bespoke `npm install` wrapper, manifest expansion, template variables, file copying) adds complexity without adoption.

If bundled workflows are needed in the future, lighter alternatives exist:

- **Scaffolding templates:** `orgloop init --template engineering-org` generates a complete project from a template (like `create-react-app`, `npm create`)
- **Recipes:** `orgloop recipe apply code-review` scaffolds multiple YAML files + prints install commands — purely additive, no runtime machinery
- **Documentation:** A "module" is a documented set of npm packages + YAML files in the examples/ directory

None of these require runtime infrastructure. They're all scaffolding-time tools that produce standard projects.

---

## 6. Migration Path

### For Existing Projects (No Module Usage)

**No migration needed.** The standard package.json + YAML flow is unchanged. New behavior is additive:

- `orgloop validate` and `orgloop start` now warn if YAML references packages not in `package.json`
- CLI fallback resolution still works, with a deprecation warning: *"Resolved @orgloop/connector-github from CLI installation, not project. Add it to your package.json for reproducible builds."*

### For Projects Using `modules:` in orgloop.yaml

At v0.1.x adoption, this is unlikely. If it exists:

1. For each `modules:` entry, find the module's `orgloop-module.yaml` manifest
2. Identify what connectors, transforms, and routes the module declares
3. Create equivalent explicit YAML files for each
4. Move them into the project's `connectors/`, `transforms/`, `routes/` directories
5. Remove the `modules:` block from `orgloop.yaml`
6. Add explicit YAML file references to the appropriate `orgloop.yaml` sections
7. Run `orgloop doctor` to verify

### Version Strategy

- **0.2.0:** Remove module system, add pre-flight validation. Semver minor (pre-1.0).
- Deprecation notice in 0.1.x changelog pointing to this proposal.

---

## 7. Implementation Plan

### Phase 1: Remove Module System (~0.5 day)

- [ ] Remove `orgloop add module` subcommand from `packages/cli/src/commands/add.ts`
- [ ] Remove `packages/cli/src/module-resolver.ts`
- [ ] Remove module expansion call from `packages/cli/src/config.ts`
- [ ] Remove `modules:` from YAML schema in `packages/core/src/schema.ts`
- [ ] Keep module types in `@orgloop/sdk` as deprecated for one release (existing module packages reference them)
- [ ] Remove/update tests: `packages/sdk/src/__tests__/module.test.ts`, `packages/cli/src/__tests__/module-e2e.test.ts`
- [ ] Remove `modules/engineering/` and `modules/minimal/` workspace packages
- [ ] Update `pnpm-workspace.yaml` to remove `modules/` workspace root
- [ ] Run: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`

### Phase 2: Pre-flight Validation (~0.5 day)

- [ ] New utility: `packages/cli/src/dep-check.ts` — reads project `package.json`, collects all `connector:`, `package:` (transforms), and `type:` (loggers) references from loaded config, cross-references against `dependencies` + `devDependencies`
- [ ] Integrate into `orgloop doctor`: show ✓/✗ per package reference with install command
- [ ] Integrate into `orgloop start`: run dep check before dynamic imports, exit with actionable error if missing
- [ ] Support `--json` output for CI/automation
- [ ] Add fallback resolution warning in `project-import.ts`: log when CLI fallback is used

### Phase 3: Fix Fail-Open Plugins (~0.5 day)

- [ ] In `start.ts`: change transform loading from warn-and-continue to error-and-exit
- [ ] In `start.ts`: change logger loading from warn-and-continue to error-and-exit
- [ ] Add `optional: true` field to transform/logger YAML schema for intentional degraded mode
- [ ] Unify instantiation pattern across connectors, transforms, and loggers
- [ ] Add tests for missing-package error paths

### Phase 4: Init and Scaffolding Improvements (~0.5 day)

- [ ] Replace `"latest"` with caret ranges in `init.ts` `collectProjectDeps()` — use current published version
- [ ] Replace hardcoded `CONNECTOR_PACKAGES` map with a registry file (`connector-registry.json`) that can be updated without code changes
- [ ] Add `package.json` to all `examples/` projects with pinned deps
- [ ] Update post-scaffold message in `orgloop init`: emphasize `npm install` as next step

### Phase 5: Documentation (~0.5 day)

- [ ] Update plugin system spec (`docs-site/src/content/docs/spec/plugin-system.md`): remove module-specific language, document validation behavior
- [ ] Update module spec or replace with "Project Structure" guide
- [ ] Add "Adding a Connector" guide: standard npm workflow
- [ ] Update `AGENTS.md`: remove module system from architecture docs
- [ ] Update examples/ README files

### Total Scope

| Phase | Effort | Risk |
|-------|--------|------|
| 1: Remove Module System | 0.5 day | Low — mostly deletion |
| 2: Pre-flight Validation | 0.5 day | Low — additive, new utility |
| 3: Fix Fail-Open Plugins | 0.5 day | Low — behavior change, but correct |
| 4: Init Improvements | 0.5 day | Low — cosmetic + registry file |
| 5: Documentation | 0.5 day | None |
| **Total** | **~2.5 days** | |

---

## Appendix A: Ecosystem Comparison

How comparable Node tools handle plugin dependencies:

| Tool | Config Format | Plugin Reference | Who Installs | Discovery | Validation |
|------|--------------|------------------|-------------|-----------|------------|
| **ESLint (flat config)** | JS | Explicit `import` | User (`npm install`) | None — explicit | Config load fails if import fails |
| **Vite** | JS | Explicit `import` | User | None — explicit | Config load fails |
| **Tailwind CSS** | JS | Explicit `import`/`require` | User | None | Config load fails |
| **Prettier** | JSON/YAML | String → `import()` | User | None | Runtime error |
| **Storybook** | JS | String in addons array | User + `storybook add` helper | None | Startup error |
| **Gatsby** | JS | String (`resolve` field) | User | None | Build error |
| **Turbo** | JSON | Reads `package.json` deps | User | None | N/A |
| **OrgLoop (current)** | YAML | String in `connector:` field | User + `orgloop add module` | None | Runtime import error |
| **OrgLoop (proposed)** | YAML | String in `connector:` field | User only (`npm install`) | None | Pre-flight in `doctor`/`start` |

**Industry consensus (2024-2026):** Explicit over implicit. String references (Prettier, Gatsby, Storybook) or explicit imports (ESLint, Vite, Tailwind). Never auto-discovery from node_modules.

## Appendix B: Resolution Chain (After This Proposal)

```
User runs: orgloop start

1. loadCliConfig()                          [config.ts]
   ├── Read orgloop.yaml
   ├── For each connectors/*.yaml:
   │   ├── Read YAML file
   │   └── Collect source/actor defs with connector: "@orgloop/connector-github"
   ├── For each transforms/*.yaml:
   │   └── Collect transform defs with package: "@orgloop/transform-filter"
   ├── For each loggers/*.yaml:
   │   └── Collect logger defs with type: "@orgloop/logger-file"
   ├── Auto-discover routes/*.yaml
   └── Return OrgLoopConfig

2. Pre-flight validation (NEW)              [dep-check.ts]
   ├── Read project package.json
   ├── For each connector/transform/logger reference:
   │   └── Verify package exists in dependencies or devDependencies
   └── Exit with actionable error if any missing:
       "Missing: @orgloop/connector-github — run: npm install @orgloop/connector-github"

3. createProjectImport(projectDir)          [project-import.ts]
   └── Returns async function:
       ├── Try: createRequire(projectDir).resolve(pkg) → import()
       └── Fallback: bare import(pkg) + log warning (CLI's own node_modules)

4. resolveConnectors(config, importFn)      [resolve-connectors.ts]
   ├── Collect unique package names from config.sources + config.actors
   ├── For each package:
   │   ├── await importFn(package)
   │   └── Call registration = mod.default()
   └── Instantiate sources/actors from registrations

5. Resolve transforms                       [start.ts]
   ├── For each transform with package:
   │   ├── await importFn(package)
   │   └── Call register(), instantiate transform
   └── Error on failure (CHANGED from warn to error)

6. Resolve loggers                          [start.ts]
   ├── For each logger:
   │   ├── await importFn(logger.type)
   │   └── Call register(), instantiate logger
   └── Error on failure (CHANGED from warn to error)

7. runtime.loadModule(config, { sources, actors, transforms, loggers })
   └── Engine runs with fully-resolved plugin instances
```

No magic discovery. No bespoke install commands. Standard Node.js module resolution.

## Appendix C: Future Considerations

If OrgLoop grows to need richer plugin discovery, the natural next step is **Option E (JS config)** — not as a replacement for YAML, but as an alternative for power users:

```
orgloop.yaml       → Simple, declarative, approachable (default)
orgloop.config.ts  → Composable, type-safe, for complex setups
```

This is the pattern Prettier uses (JSON for simple, JS for complex). It can be added without breaking YAML support.

For bundled workflows (the module concept), **scaffolding templates** (`orgloop init --template engineering-org`) are the right long-term answer. They produce standard projects with standard dependencies — no runtime machinery needed.
