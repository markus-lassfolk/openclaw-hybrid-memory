# Release notes — OpenClaw Hybrid Memory **2026.6.260**

**Release date:** 2026-06-26  
**Since:** [2026.6.259](release-notes-2026.6.259.md) (or CHANGELOG [2026.6.259])  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.6.260]**

## Highlights

- **Maintenance reliability (#1955–#1963):** `audit health --strict-errors` for warning-tolerant weekly cron; bounded distill truncation handling; unified maintenance tick logging; cron bash harness exec guidance; workshop digest harness; verification model skips disabled providers.
- **Procedural memory (#1965–#1967):** `memory_procedure_feedback` returns `isError: true` on `procedure_not_found`; optional `registerIfMissing` greenfield capture; SKILL workflow docs for recall → feedback vs first-run paths.

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.6.260
```

Restart the gateway after upgrading. Align `openclaw-hybrid-memory-install` to **2026.6.260** if you use the installer package.

## Post-upgrade checks

- `openclaw hybrid-mem audit health --strict-errors --json` — exits 0 on warnings-only backlog
- Grep gateway logs for `maintenance tick` success lines after 65+ minutes
- Agent smoke: unknown `memory_procedure_feedback` id → `isError: true`; `registerIfMissing` + steps → draft created
