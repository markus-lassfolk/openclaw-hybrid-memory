# Release notes — OpenClaw Hybrid Memory **2026.6.250**

**Release date:** 2026-06-25  
**Since:** [2026.6.241](CHANGELOG.md#20266241---2026-06-24)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.6.250]**

## Highlights

Maintenance hotfix for [#1942](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1942): nightly `maintenance-nightly` was failing every night once the contradiction ambiguity backlog crossed the degraded threshold, starving all downstream maintenance steps.

### What changed

- Degraded contradiction backlog is a **monitoring signal**, not a fatal step failure — the orchestrator continues and cron guard files advance.
- Cron validation distinguishes monitoring-only issues from guard-blocking degraded outcomes.
- `reflect-rules` no longer fails on tolerated `invalid_response_format` flakes.
- Legacy `nightly-memory-sweep` `resolve-contradictions` CLI keeps shell exit `0` under cron wrappers while standalone runs still exit `2` on degraded backlog.

### After upgrading

```bash
openclaw plugins update openclaw-hybrid-memory@2026.6.250
systemctl --user restart openclaw-gateway
openclaw hybrid-mem verify
```

Confirm the next `maintenance-nightly` run completes past `resolve-contradictions` and updates `~/.openclaw/cron/guard/maintenance-nightly.ms`.
