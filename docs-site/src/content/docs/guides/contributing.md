---
title: Contributing
description: How to contribute to OrgLoop — setup, code style, and PR process.
---

Whether you are fixing a typo, building a connector, or proposing a new feature -- contributions are welcome.

## Setup

```bash
git clone https://github.com/c-h-/orgloop.git
cd orgloop

# Install dependencies (requires pnpm 9+ and Node 22+)
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Lint
pnpm lint
```

The project uses **pnpm workspaces** + **Turborepo** for the monorepo, **TypeScript** across all packages, **Biome** for linting and formatting, and **Vitest** for testing.

## Workspace layout

```
packages/
  sdk/          — Plugin development kit (interfaces, test harness)
  core/         — Runtime engine (event bus, router, scheduler)
  cli/          — orgloop CLI
  server/       — HTTP API server
connectors/
  github/       — GitHub source connector
  linear/       — Linear source connector
  claude-code/  — Claude Code hook-based connector
  openclaw/     — OpenClaw actor connector
  webhook/      — Generic webhook source/actor
  cron/         — Scheduled source (cron + interval syntax)
  agent-ctl/    — Agent session lifecycle source
  docker/       — Docker container + Kind cluster actor
  gog/          — Gmail via gog CLI source
transforms/
  filter/       — Event filter (match/exclude/jq)
  dedup/        — SHA-256 deduplication
  enrich/       — Add, copy, and compute fields
  agent-gate/   — Gate events on running agent sessions
loggers/
  console/      — Console logger (ANSI colors)
  file/         — File logger (JSONL, rotation, gzip)
  otel/         — OpenTelemetry OTLP export
  syslog/       — RFC 5424 syslog protocol
examples/
  minimal/      — Simplest possible setup
  engineering-org/ — Full engineering org example
```

**Dependency chain:** `sdk` -> `core` -> everything else. Turborepo handles build order via `"dependsOn": ["^build"]`.

## Running tests

```bash
# All tests across the monorepo
pnpm test

# Single package
cd packages/core && npx vitest run

# Single test file
npx vitest run packages/core/src/__tests__/router.test.ts
```

Tests use Vitest with globals enabled -- no need to import `describe`, `it`, or `expect`. Tests are colocated with source code in `src/__tests__/*.test.ts`.

## Code style

OrgLoop uses **Biome** for linting and formatting:

- Tabs (2-width)
- Single quotes
- Semicolons
- Trailing commas
- Line width: 100 characters
- Pure ESM (`"type": "module"` in every package, `verbatimModuleSyntax: true`)

Run `pnpm lint` to check and `pnpm lint:fix` to auto-fix.

## Before pushing

All four must pass. CI runs these on every PR.

```bash
pnpm build && pnpm test && pnpm typecheck && pnpm lint
```

## Branch naming

- `feat/*` -- New features
- `fix/*` -- Bug fixes
- `docs/*` -- Documentation changes

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) with the package name as scope:

```
feat(connector-github): add PR label filtering
fix(core): handle empty checkpoint on first poll
docs: update contributing guide with transform examples
chore(sdk): bump vitest to v3.1
```

One concern per commit. Do not bundle unrelated changes.

## PR process

1. **Fork** the repository
2. **Branch** from `main` using the naming convention above
3. **Make your changes** -- keep PRs focused on a single concern
4. **Test** -- run `pnpm test` and ensure your changes are covered
5. **Lint** -- run `pnpm lint` and fix any issues
6. **Type check** -- run `pnpm typecheck`
7. **Open a PR** against `main` with a clear description

In your PR description:
- Summarize the scope of the change
- Note what testing you performed
- Mention any user-facing changes

## AI-assisted PRs

AI-assisted contributions are welcome and held to the same quality bar as any other contribution. If your PR was AI-assisted:

- Mark it as AI-assisted in the PR description
- Note the degree of AI involvement (generated, reviewed, pair-programmed)
- Confirm that you understand the code and have reviewed it yourself

The checklist helps reviewers understand context, not gatekeep.

## Good first contributions

- **New connectors** -- check issues labeled `connector-request` for ideas. See [Building Connectors](/guides/connector-authoring/) for the pattern.
- **New transforms** -- script or package transforms for common filtering/enrichment needs. See [Building Transforms](/guides/transform-authoring/).
- **Documentation** -- improvements to guides, examples, or inline code comments
- **Example projects** -- self-contained projects in `examples/` that demonstrate specific patterns
- **Bug fixes** -- check issues labeled `bug` for reported problems

Browse the existing connectors in `connectors/` and transforms in `transforms/` to see the patterns in use. Read the SDK source in `packages/sdk/src/` to understand the core interfaces.
