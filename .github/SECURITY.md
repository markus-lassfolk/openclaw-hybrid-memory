# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x (latest) | :white_check_mark: |
| Older 0.x | :x: |

Only the latest `0.x` release receives security fixes. Please update to the current release before reporting.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Report vulnerabilities via [GitHub Private Security Advisory](https://github.com/markus-lassfolk/openclaw-hybrid-memory/security/advisories/new).

Please include:
- A clear description of the vulnerability
- Steps to reproduce or a proof-of-concept
- Affected versions
- Suggested remediation (if known)

## Response Timeline

| Milestone | Target |
|-----------|--------|
| Acknowledgement | 48 hours |
| Initial assessment | 5 business days |
| Fix or mitigation | 30 days |

We will keep you informed throughout the process and credit reporters in the release notes (unless you prefer to remain anonymous).

## Scope

Issues we consider in scope:

- **Credential exposure** — plugin storing or logging secrets in plaintext
- **SQLite injection** — unsanitized input reaching raw SQL queries
- **Insecure defaults** — configurations that expose data or bypass access controls by default
- **Path traversal** — reading or writing files outside the intended data directory
- **Dependency vulnerabilities** — CVEs in direct dependencies with a clear exploit path

Out of scope: issues in upstream dependencies without a direct exploit path, performance issues, theoretical concerns without reproduction steps.
