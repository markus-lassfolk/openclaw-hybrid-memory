# Release notes — OpenClaw Hybrid Memory **2026.6.161**

**Release date:** 2026-06-16  
**Since:** [2026.6.160](CHANGELOG.md#20266160---2026-06-16)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.6.161]**

## Highlights

Fixes **#1923**: hybrid-memory cron tooling (`verify`, `verify --fix`, install, maintenance inventory, dashboard, cron guard, active-task wake scheduling) now reads and writes the live OpenClaw SQLite cron store on 6.8+ hosts instead of recreating legacy `jobs.json`.

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.6.161
```

Restart the gateway after upgrading. Align `openclaw-hybrid-memory-install` to **2026.6.161** if you use the installer package.
