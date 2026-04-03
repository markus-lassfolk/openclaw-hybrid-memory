# Release Notes — OpenClaw Hybrid Memory 2026.4.33

**Date:** 2026-04-03  
**Previous baseline:** 2026.4.32

## Summary

**2026.4.33** ships **`scripts/task-queue.sh`** for cron and autonomous pipelines (**#1000**, **#1001**): `touch` / `status` via `openclaw hybrid-mem`, optional **`run`** with `flock`, PID lifecycle, history archive, and idle restore — plus review hardening. Bumps the npm package, `openclaw.plugin.json`, and the standalone installer.

For issue links and the full list, see **[CHANGELOG.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)** (section **2026.4.33**).

---

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.4.33
```

Restart the gateway after upgrading.

---

## Links

- [CHANGELOG (full)](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)
