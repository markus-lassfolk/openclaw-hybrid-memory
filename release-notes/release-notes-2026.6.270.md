# Release notes — OpenClaw Hybrid Memory **2026.6.270**

**Release date:** 2026-06-27  
**Since:** [2026.6.261](release-notes-2026.6.261.md)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.6.270]**

## Highlights

- **Goals & active tasks reliability:** Fixes recall/store split-brain, facts-ledger tool crashes, injection filters that hid checkpointed work, and heartbeat turns with no goal context.
- **Default ledger:** `activeTask.ledger` now defaults to `facts` (checkpoint is canonical); markdown ledger still supported with automatic file sync on checkpoint.

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.6.270
```

Restart the gateway after upgrading. Align `openclaw-hybrid-memory-install` to **2026.6.270** if you use the installer package.

## Post-upgrade checks

- `active_task_list` works when `activeTask.ledger: facts`
- After `active_task_checkpoint`, tasks appear in turn injection (`<active-tasks>`) or `ACTIVE-TASKS.md` (markdown ledger)
- Heartbeat turns show goal summary even when goals are in stewardship cooldown
