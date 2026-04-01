# Release Notes — OpenClaw Hybrid Memory 2026.4.101

**Date:** 2026-04-01  
**Previous baseline:** 2026.4.10

## Summary

**2026.4.101** is a **patch** release focused on **interactive recall latency** (SQLite FTS on large `facts.db`) and **agent identity** on routed channels (e.g. WhatsApp).

### What changed

- **Interactive FTS fast path** — `FactsDB.search()` accepts **`interactiveFtsFastPath`** (enabled for auto-recall): caps OR-joined FTS terms and uses a **two-phase** query (id + rank first, then full rows) to avoid long stalls on the gateway hot path.
- **Agent id resolution** — `resolveAgentIdFromHookEvent()` in `lifecycle/resolve-agent-id.ts` reads common **`event.session`** shapes when **`api.context.agentId`** is missing; **`stage-setup`** uses it for `currentAgentIdRef`.
- **Documentation** — [INTERACTIVE-RECALL-LATENCY.md](../docs/INTERACTIVE-RECALL-LATENCY.md) explains long FTS wall times and upstream **`api.context.agentId`** expectations.

---

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.4.101
```

Restart the gateway after upgrading.

---

## Links

- [CHANGELOG (full)](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)
