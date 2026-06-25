# Release notes — OpenClaw Hybrid Memory **2026.6.253**

**Release date:** 2026-06-25  
**Since:** [2026.6.252](CHANGELOG.md#2026252---2026-06-25)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.6.253]**

## Highlights

QA hardening follow-up for [#1945](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1945) and [#1947](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1947).

### What changed

- **Distill dedupe:** Restored `vectorDb.hasDuplicate` when `fuzzyDedupe` is off; redact before lexical pre-check; count `storeResult.skipped` in telemetry.
- **Vector fallback:** Skip ineffective `hasDuplicate` when LanceDB schema is invalid.
- **Entity safety:** Distillation vector dedupe requires compatible entity slugs (prefix), not key-only.
- **LWW overload:** Flag asymmetric ref splits (2+1) while preserving 2+2 queue-drift supersede (#1945).

### After upgrading

```bash
openclaw plugins update openclaw-hybrid-memory@2026.6.253
systemctl --user restart openclaw-gateway
openclaw hybrid-mem verify
```
