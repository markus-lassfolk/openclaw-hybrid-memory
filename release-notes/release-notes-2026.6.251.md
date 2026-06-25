# Release notes — OpenClaw Hybrid Memory **2026.6.251**

**Release date:** 2026-06-25  
**Since:** [2026.6.250](CHANGELOG.md#20266250---2026-06-25)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.6.251]**

## Highlights

Fix for [#1945](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1945): `resolve-contradictions --project-state-lww` was blocking all qualifying candidates because the `possible-entity-reuse` heuristic summed PR/issue refs across both facts in a pair.

### What changed

- Count distinct `#NNNN` refs **per fact**; flag only when either fact alone exceeds the threshold.
- Legitimate project-state `status` / `next` transitions that mention different PRs in old vs new values can now qualify for LWW supersede again.

### After upgrading

```bash
openclaw plugins update openclaw-hybrid-memory@2026.6.251
systemctl --user restart openclaw-gateway
openclaw hybrid-mem verify
```

Re-run a dry-run to confirm candidates now qualify:

```bash
openclaw hybrid-mem quality contradictions --project-state-lww --dry-run --verbose
```
