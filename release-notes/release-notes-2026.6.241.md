# Release notes — OpenClaw Hybrid Memory **2026.6.241**

**Release date:** 2026-06-24  
**Since:** [2026.6.240](CHANGELOG.md#20266240---2026-06-24)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.6.241]**

## Highlights

Hotfix release for three bugs surfaced during the **2026.6.240** upgrade on Maeve:

- [#1938](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1938) — gateway registration failed with `Missing required legacy helper functions`
- [#1939](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1939) — `memory_crystallize_restore` missing from `contracts.tools`
- [#1940](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1940) — Workboard startup probe timed out during cold gateway start

### What changed

- Fixed `hasBoundMemoryToolHelpers()` so `wal` on a pre-bound context no longer forces legacy mode.
- Declared `memory_crystallize_restore` in the plugin contract manifest.
- Deferred Workboard cold-start probe (60s) with retry/backoff before arming sync.

### After upgrading

```bash
openclaw plugins update openclaw-hybrid-memory@2026.6.241
systemctl --user restart openclaw-gateway
openclaw hybrid-mem verify
```

Within ~2 minutes of a cold restart with Workboard enabled, the journal should show `Workboard adapter connected (startup)` without requiring a manual CLI re-register.
