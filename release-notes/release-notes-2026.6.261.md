# Release notes — OpenClaw Hybrid Memory **2026.6.261**

**Release date:** 2026-06-26  
**Since:** [2026.6.260](release-notes-2026.6.260.md) (or CHANGELOG [2026.6.260])  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.6.261]**

## Highlights

- **Dashboard startup (#1968):** Mission Control no longer fails on gateway boot with `embeddingRegistry is not defined`.
- **Install safety (#1969):** `hybrid-mem install` no longer writes `flushEveryCompaction` into OpenClaw core config (avoids gateway crash-loop until `doctor --fix`).
- **Consolidation:** LLM merge calls use the correct OpenAI client parameter.

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.6.261
```

Restart the gateway after upgrading. Align `openclaw-hybrid-memory-install` to **2026.6.261** if you use the installer package.

## Post-upgrade checks

- Gateway log: `memory-hybrid: dashboard started on http://127.0.0.1:<port>` when `dashboard.enabled` is true
- `openclaw config validate` passes after `openclaw hybrid-mem install`
- `curl http://127.0.0.1:<dashboard-port>/` returns 200
