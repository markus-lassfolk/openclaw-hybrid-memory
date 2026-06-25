# Release notes — OpenClaw Hybrid Memory **2026.6.252**

**Release date:** 2026-06-25  
**Since:** [2026.6.250](CHANGELOG.md#20266250---2026-06-25)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.6.252]**

## Highlights

Combined maintenance release for [#1945](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1945) and [#1947](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1947).

### What changed

- **Project-state LWW:** Per-fact PR/issue ref counting stops split-ref false positives on `possible-entity-reuse`.
- **Distill dedupe:** LanceDB neighbour candidates now reach `applyDedupe`; degraded vector search falls back to `hasDuplicate`; distillation project facts can vector-dedupe across entity slug drift.
- **Observability:** Distill reports `dedupeDegraded` / `distillDedupeMode` when vector search is unavailable.

### After upgrading

```bash
openclaw plugins update openclaw-hybrid-memory@2026.6.252
systemctl --user restart openclaw-gateway
openclaw hybrid-mem verify
```

Validate maintenance impact:

```bash
openclaw hybrid-mem quality contradictions --project-state-lww --dry-run --verbose
# After the next nightly distill, confirm distill→distill pair growth slows
```
