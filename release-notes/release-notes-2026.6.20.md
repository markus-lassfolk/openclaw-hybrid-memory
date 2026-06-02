# Release notes — OpenClaw Hybrid Memory **2026.6.20**

**Release date:** 2026-06-01  
**Since:** [2026.5.311](release-notes-2026.5.311.md)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.6.20]**

## Highlights

- **Adaptive catch-up maintenance** for `enrich-entities` and `reembed-vectorless`: pressure-aware batch sizing, pacing backoff, and vectorless SLO repair summaries when catching up backlog ([#1792](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1792)).
- **Maintenance and extraction reliability**: directive vector dedupe, richer maintenance CLI diagnostics, dream-cycle durable stage markers, and clearer contradiction-triage output ([#1794](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1794), [#1783](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1783), [#1782](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1782)).
- **Cron / embedding fixes**: persona-proposals no longer reports success on LLM failure; embedding path skips hopeless `ByteString` retries; agent-end narrative hook model config restored ([#1793](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1793), [#1777](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1777), [#1778](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1778)).

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.6.20
```

Restart the gateway after upgrading. Align `openclaw-hybrid-memory-install` to **2026.6.20** if you use the installer package.
