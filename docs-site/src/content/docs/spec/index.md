---
title: "Specification Overview"
description: "OrgLoop engineering specification — the complete design document for the event routing framework."
---

**Version:** 0.3.0-draft
**Date:** 2026-02-08
**Status:** Proposal
**Author:** Charlie Hulcher

---

## Table of Contents

1. [Repo Organization](./repo-organization/)
2. [Canonical Definitions](./config-schema/)
3. [Tech Stack Decision](./tech-stack/)
4. [Scale Design](./scale-design/)
5. [MVP Validation Plan](./validation-plan/)
6. [Installation & Pluggability](./plugin-system/)
7. [CLI Design](./cli-design/)
8. [API/SDK Runtime Modes](./runtime-modes/)
9. [Built-in Transforms](./transforms/)
10. [Built-in Loggers](./loggers/)
11. [Project Model](./modules/)
12. [Maturity Roadmap](./roadmap/)
13. [Scope Boundaries & DX Vision](./scope-boundaries/)
14. [Runtime Lifecycle](./runtime-lifecycle/)

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
