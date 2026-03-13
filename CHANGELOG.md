# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.7.2] - 2026-03-13

feat: add @orgloop/connector-linear-webhook for real-time Linear events


## [0.7.1] - 2026-03-12

Publish @orgloop/connector-github-webhook (real-time GitHub events via webhooks). Fix connector-openclaw to forward model/thinking/timeout_seconds fields to agent sessions.


## [0.7.0] - 2026-03-12

feat(connector-github): issue event polling for opened/labeled/assigned events (#106). feat(connector-github): webhook-based connector for real-time event delivery (#108). feat: file-based checkpoint persistence for connectors (#107). feat: SOP execution audit trail with output validation and loop detection (#92). fix: daemon .env loading on module registration + restart reliability (#104, #95). docs: REST API endpoints in README (#85).


## [0.6.1] - 2026-03-11

feat(github): add pr_state, pr_merged to provenance. feat(cli): persist registered modules across daemon restarts. feat(core): templated session_key for resource-correlated event batching.


## [0.6.0] - 2026-03-09

feat: callback-first delivery, dynamic threadId, docs audit (#94, #97, #98)


## [0.4.0] - 2026-02-25

### Added

- Batch GraphQL polling replaces N+1 REST/SDK patterns for GitHub and Linear connectors (#58)
- HTTP keep-alive connection pooling for connectors via SDK (#59)
- Auto-register into running daemon without `--daemon` flag (#63)
- Patterns & Recipes and Transform Filter Deep Dive documentation guides (#62)

### Fixed

- Retry `fetchSinglePull` to prevent `pr_author` degradation (#60)

## [0.3.0] - 2026-02-24

### Added

- OpenClaw `session_key` interpolation with event fields (#51)

### Fixed

- GitHub token rotation, per-endpoint error isolation, and `resource_id` for dedup (#50)
- Resolve lint warnings (unused imports/params) (#52)

## [0.2.0] - 2026-02-22

### Added

- Multi-module single daemon runtime (#45)
- Per-route `channel`/`to` overrides for OpenClaw connector (#43)

## [0.1.10] - 2026-02-20

### Added

- Prometheus metrics endpoint

### Fixed

- GitHub App installation token support in `doctor` validator (#40)
- Include `review_id` in PR review events for dedup (#38)
- Tweak `init` and readme for minimal webhook demo (#34)
- Update docs site GitHub URL to orgloop org (#36)

## [0.1.9] - 2026-02-18

Released from version 0.1.8.

## [0.1.8] - 2026-02-16

Released from version 0.1.7.

## [0.1.7] - 2026-02-16

Released from version 0.1.6.

## [0.1.6] - 2026-02-12

Released from version 0.1.5.

## [0.1.5] - 2026-02-11

Released from version 0.1.4.

## [0.1.4] - 2026-02-10

Released from version 0.1.3.

## [0.1.3] - 2026-02-09

Released from version 0.1.2.

## [0.1.2] - 2026-02-09

Released from version 0.1.1.

## [0.1.1] - 2026-02-09

Released from version 0.1.0.

## [0.1.0] - 2026-02-09

### Added

- Core engine with event bus, router, scheduler, and transform pipeline
- Five primitives: Sources, Actors, Routes, Transforms, Loggers
- Three event types: resource.changed, actor.stopped, message.received
- WAL-based event bus for durability (FileWalBus)
- File-based checkpoint store for source deduplication
- Engine HTTP listener for webhook-based sources (localhost-only, port 4800)
- CLI commands: init, validate, env, doctor, plan, apply, stop, status, logs, hook, test, inspect, add, version, install-service, service
- Connectors: GitHub (poll), Linear (poll), Claude Code (webhook/hook), OpenClaw (target), Webhook (generic source+target), Cron (scheduled)
- Transforms: filter, dedup, enrich
- Loggers: console, file, OpenTelemetry, syslog
- Module system with parameterized templates
- Modules: engineering, minimal
- YAML config with AJV validation and environment variable substitution
- Route graph validation
- SDK test harness
- Documentation site (Astro Starlight)
- Release tooling with 10-step publish pipeline
- E2E pipeline tests
- Examples: minimal, engineering-org, github-to-slack, multi-agent-supervisor, beyond-engineering, org-to-org
