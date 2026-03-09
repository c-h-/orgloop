---
title: "Specification Overview"
description: "OrgLoop engineering specification — the complete design document for the event routing framework."
---

**Version:** 0.6.0
**Date:** 2026-03-09
**Status:** Active
**Author:** Charlie Hulcher

---

## Table of Contents

1. [Repo Organization](./repo-organization/)
2. [Canonical Definitions](./config-schema/)
3. [Tech Stack Decision](./tech-stack/)
4. [Scale Design](./scale-design/)
5. [MVP Validation Plan](./validation-plan/)
6. [Lifecycle Contract](./lifecycle-contract/)
7. [Installation & Pluggability](./plugin-system/)
8. [CLI Design](./cli-design/)
9. [API/SDK Runtime Modes](./runtime-modes/)
10. [Built-in Transforms](./transforms/)
11. [Built-in Loggers](./loggers/)
12. [Project Model](./modules/)
13. [Maturity Roadmap](./roadmap/)
14. [Scope Boundaries & DX Vision](./scope-boundaries/)
15. [Runtime Lifecycle](./runtime-lifecycle/)

> Section 11 describes the package-native project model (`package.json` + `orgloop.yaml`).

### Appendices

- [Appendix A: Event Schema (JSON Schema)](./event-schema/)
- [Appendix B: Glossary](./glossary/)
- [Appendix C: Open Decisions](./open-decisions/)
- [Appendix D: Future Extensions](./future-extensions/)

### Related Documents

- [orgctl (Environment Bootstrapper)](https://orgloop.ai/vision/orgctl/)

---

*This specification is a living document. It will be updated as implementation reveals new considerations and as the community provides feedback.*
