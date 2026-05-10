# Release notes — OpenClaw Hybrid Memory **2026.5.100**

**Context:** This release packages the reliability and stewardship fixes merged on `main` after **2026.5.94**. See **[CHANGELOG.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)** for the full **`[2026.5.100]`** section.

## Who should install

Anyone running long-lived goal/task workflows, memory lifecycle maintenance, or vector/re-index operations who needs stronger resume safety, cleaner integrity handling, and fewer false-positive issue sweeps.

## What changed (high level)

- **Active-task continuity / hygiene:** adds `active_task_checkpoint`, auto-registers active tasks for long-running workflows, and improves stale task/entity dedupe + render snapshots.
- **Goal stewardship reliability:** adds `verify --fix` heartbeat cron installer support and a pre-finalization guard for unfinished external workflows.
- **Memory/vector correctness:** closes integrity gaps in prune/recall/merge paths, hardens vector lifecycle cleanup across CLI commands, and improves WAL replay idempotency / metadata safety.
- **Operational signal quality:** reduces false-positive issue sweeps and records explicit per-goal stewardship outcomes.

## Install

```bash
npm install -g openclaw-hybrid-memory@2026.5.100
```

If you use **`openclaw-hybrid-memory-install`**, align it to **2026.5.100** so installer and plugin versions stay in sync.

## Changelog

See **[CHANGELOG.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)** — section **`[2026.5.100]`**.
