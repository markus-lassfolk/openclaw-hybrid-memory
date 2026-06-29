# Release notes — OpenClaw Hybrid Memory **2026.6.291**

**Release date:** 2026-06-29  
**Since:** [2026.6.290](../CHANGELOG.md#20266290---2026-06-29)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.6.291]**

## Highlights

- **Auto-classify MiniMax hardening (#2006):** Batch auto-classify and category discovery now disable MiniMax thinking mode, use a larger JSON output budget, strip truncated `<think>` blocks, and retry once on parse failure — fixing `batchFailures=1, reclassified=0/20` on MiniMax-M2.7-highspeed.

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.6.291
```

Restart the gateway after upgrading. Align `openclaw-hybrid-memory-install` to **2026.6.291** if you use the installer package.

## Post-upgrade checks

- `auto-classify` with `minimax/MiniMax-M3` (or another maintenance-tier model) completes with `batchFailures=0`
- If `autoClassify.model` is `minimax/MiniMax-M2.7-highspeed`, expect occasional partial failures; prefer M3 per plugin help text
