---
title: "Open Decisions (Appendix C)"
description: "Unresolved design decisions and their current status — config hot-reload, process management, and resolved items."
---

These items need resolution during implementation:

1. **Config hot-reload.** Should `orgloop start` on a running daemon cause a hot-reload of config, or require a restart? Recommendation: restart for MVP, hot-reload for v1.1.

2. ~~**Event ID generation.** `evt_` prefix + what?~~ **Resolved (MVP).** UUID v4 with `evt_` prefix (`evt_` + 16 hex chars). Trace IDs use `trc_` prefix. Implemented in `@orgloop/sdk` `event.ts`.

3. ~~**Transform timeout handling.** What happens when a script transform hangs?~~ **Resolved (MVP).** Configurable `timeout_ms` per transform (default 30s in spec, 5s in scaffolded config). Shell script transforms killed on timeout. Implemented in `@orgloop/core` transform pipeline.

4. ~~**Connector authentication.** How do connectors authenticate to source APIs?~~ **Resolved (MVP).** Environment variables referenced in config via `${GITHUB_TOKEN}` syntax. The schema loader's env var substitution resolves `${VAR_NAME}` placeholders at config load time.

5. ~~**Multi-route matching.** Can one event match multiple routes?~~ **Resolved (MVP).** Yes. An event flows through all matching routes independently. Implemented in `@orgloop/core` `router.ts` — `matchRoutes()` returns all matching routes, and the engine processes each one.

6. **Process management.** Should OrgLoop manage itself as a system service? Recommendation: provide a `orgloop service install` command that generates a launchd plist (macOS) or systemd unit (Linux), but don't require it. Users can run it however they want.

---

*This specification is a living document. It will be updated as implementation reveals new considerations and as the community provides feedback.*
