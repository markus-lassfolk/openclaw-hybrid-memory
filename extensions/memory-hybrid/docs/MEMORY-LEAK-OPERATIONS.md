# Memory leak operations guide

This document summarizes root-cause analysis from production gateway monitoring (maevevm, Apr–Jun 2026) and the mitigations shipped in hybrid-memory.

## Primary cause: in-process plugin re-register (Lance/SQLite teardown)

OpenClaw reloads the plugin registry inside the **same gateway Node process** (cron, Telegram inbound, config refresh). Each reload calls hybrid-memory `register()` → `closeOldDatabases()` → LanceDB/SQLite close + reopen.

**Symptom:** Native RSS grows in **~500MB–2.5GB steps** while V8 heap stays flat (~400–540MB). `smaps_rollup` shows multi-GB **anonymous** memory; Lance on-disk size is stable (~2–2.3GB).

**Evidence (May 19, 2026):** PID 864241 RSS 1.4GB → 5.7GB in ~4.25h with **13×** `loading openclaw-hybrid-memory` journal lines; RSS flat after reloads stopped.

### Mitigation: `OPENCLAW_HYBRID_MEM_REREGISTER_POLICY=reuse-databases`

When paths and parse-time config are unchanged, re-register **reuses** SQLite/Lance handles instead of closing them.

```bash
# systemd drop-in (recommended for long-running gateways)
Environment="OPENCLAW_HYBRID_MEM_REREGISTER_POLICY=reuse-databases"
```

Journal confirmation: `memory-hybrid: re-register reusing database handles (policy=reuse-databases)`.

**Limitation:** OpenClaw still reloads **all** bundled plugins (95+) on some events; that can grow RSS even when hybrid-memory reuses DB handles. Track separately on the OpenClaw repo.

## Secondary cause: SQLite env over-reservation

Stale `OPENCLAW_FACTS_CACHE_SIZE_KB=524288` (512MB page cache request) plus large `OPENCLAW_FACTS_MMAP_SIZE` caused ~400MB+ anonymous reservation on a ~414MB DB.

**Mitigation:** `resolveFactsDbPragmas()` clamps cache/mmap to DB file size (+ headroom) at open time.

## Tertiary: shadow table cache during re-index

Unbounded `shadowTableCache` during bulk Lance re-index could retain extra table handles.

**Mitigation:** LRU cap of 4 shadow tables (`VectorDB.SHADOW_TABLE_CACHE_MAX`).

## Monitoring

### HTTP diagnostics (gateway auth)

| Route | Purpose |
|-------|---------|
| `GET /plugins/memory-public/process-memory` | Compact heap/RSS snapshot |
| `GET /plugins/memory-public/memory-diagnostics` | Full breakdown + `leakHints` + reregister metrics |

Used by Maeve `scripts/vm-memory-snapshot.py` (cron */15).

### Key log fields (`vm-memory-snapshot.jsonl`)

- `gateway.rss_kb` — process RSS
- `gateway.memory_diag.native_mb` — estimated native (RSS − heap − external)
- `gateway.hybrid_reregister_policy` — should be `reuse-databases`
- `gateway.hybrid_reregister_metrics.databaseReuses` — increments on hot reload without teardown
- `gateway.hybrid_plugin_reload_1h` — journal reload count (from `hybrid-plugin-reload.jsonl`)

### Interpreting slopes

| Pattern | Likely cause |
|---------|----------------|
| +500MB–2.5GB step, `reload>0` in same PID | Full Lance/SQLite teardown on re-register |
| +500MB–2.5GB step, reuse policy active, heavy agent activity | Lance query / Rust allocator retention or OpenClaw module reload |
| Flat RSS for hours after reloads stop | Teardown-driven leak confirmed |
| Restart drops RSS 5GB → ~600MB | Native memory not returned until process exit |

## Operational checklist

1. Set `OPENCLAW_HYBRID_MEM_REREGISTER_POLICY=reuse-databases` on gateway systemd unit.
2. Remove or reduce stale `OPENCLAW_FACTS_CACHE_SIZE_KB` / `OPENCLAW_FACTS_MMAP_SIZE` overrides (plugin now clamps).
3. Schedule gateway restart if RSS > 8GB despite reuse policy (weekly or on alert).
4. Watch journal for `re-register falling back to full teardown` — indicates config/path drift.
5. File OpenClaw issues for in-process full plugin registry reload (not hybrid-memory).

## Related env vars

| Variable | Default | Notes |
|----------|---------|-------|
| `OPENCLAW_HYBRID_MEM_REREGISTER_POLICY` | `default` (full teardown) | Use `reuse-databases` on gateways |
| `OPENCLAW_FACTS_CACHE_SIZE_KB` | 64000 | Clamped to ~1.5× DB size |
| `OPENCLAW_FACTS_MMAP_SIZE` | 268435456 | Clamped to DB size + 64MB |
