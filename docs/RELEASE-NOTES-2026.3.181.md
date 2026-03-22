# Release notes — OpenClaw Hybrid Memory 2026.3.181

**Release date:** 2026-03-18

No functional changes from 2026.3.180. This release fixes the **Release workflow** so that creating a GitHub Release from a tag no longer hits a concurrency deadlock (the workflow now completes and publishes to npm).

---

## What’s in this release

### Fixed

- **Release workflow (CI/CD):** When the Release workflow ran on tag push, it deadlocked with the called CI workflow because both used the same concurrency group. The Release workflow now uses a distinct concurrency group (`release-cd-*`) so tag-triggered releases complete and create the GitHub Release and npm packages.

---

## Upgrade

Same as 2026.3.180. Install or update to 2026.3.181 if you want this build; otherwise 2026.3.180 is equivalent for plugin behavior.

Full changelog: [CHANGELOG.md](../CHANGELOG.md#20263181---2026-03-18).
