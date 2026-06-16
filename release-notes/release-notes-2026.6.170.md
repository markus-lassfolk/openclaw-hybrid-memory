# Release notes — OpenClaw Hybrid Memory **2026.6.170**

**Release date:** 2026-06-17  
**Since:** [2026.6.161](CHANGELOG.md#20266161---2026-06-16)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.6.170]**

## Highlights

Fixes **#1925**: verify no longer false-flags standalone plugin cron jobs (workshop reminder, digests, log analyzer) under consolidated orchestrator mode; Workboard probes/sync use `openclaw gateway call` when HTTP `/rpc/*` is unavailable on OpenClaw 6.8+; summary.json warnings target only the latest harness-enabled nightly run.

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.6.170
```

Restart the gateway after upgrading. Align `openclaw-hybrid-memory-install` to **2026.6.170** if you use the installer package.
