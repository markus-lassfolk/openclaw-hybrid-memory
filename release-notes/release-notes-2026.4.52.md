# Release Notes — OpenClaw Hybrid Memory 2026.4.52

**Date:** 2026-04-05  
**Previous baseline:** 2026.4.51

## Summary

**2026.4.52** improves **operator-facing configuration** for **goal stewardship** and **active tasks** (`hybrid-mem config`, `config-set goalStewardship`, `goals config`, `active-tasks config`), standardizes the default working-memory filename on **`ACTIVE-TASKS.md`** (with **legacy read** from `ACTIVE-TASK.md` when the new file is absent), and hardens **optimistic writes** and **`task-queue-status --with-active-tasks`** so resolved paths and mtimes stay consistent during migration.

---

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.4.52
```

Restart the gateway after upgrading. If you use the standalone installer package, align its version with **2026.4.52** as well.

---

## Links

- [CHANGELOG (full)](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md) — search for **`2026.4.52`** for this release’s section.
