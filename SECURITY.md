# Security Policy

If you believe you've found a security issue in OrgLoop, please report it privately.

## Reporting

**Email:** security@orgloop.ai

Include: reproduction steps, impact assessment, and (if possible) a minimal PoC.

We will acknowledge receipt within 48 hours and aim to provide a fix or mitigation plan within 7 days for confirmed vulnerabilities.

## Security Model

OrgLoop's security architecture is designed around several core principles:

- **Polling over webhooks** -- zero inbound attack surface by default
- **Env var substitution** -- secrets never live in YAML config files (`${GITHUB_TOKEN}`)
- **Transforms for injection defense** -- inspect and sanitize payloads before they reach actors
- **Least-privilege routing** -- actors only see events their routes explicitly match
- **Audit by default** -- loggers are first-class primitives, not optional add-ons
- **Plan before start** -- `orgloop plan` shows changes before execution

For the full security architecture, see the [Security guide](https://orgloop.ai/guides/security/).

## Bug Bounties

OrgLoop is a labor of love. There is no bug bounty program and no budget for paid reports. Please still disclose responsibly so we can fix issues quickly. The best way to help the project right now is by sending PRs.

## Out of Scope

- Running OrgLoop's webhook listener on the public internet without a reverse proxy
- Prompt injection attacks against actors (actors are external to OrgLoop)
- Using OrgLoop in ways the docs recommend against
