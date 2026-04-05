# Public API Surface (Issue #1027)

`openclaw-hybrid-memory` now exposes a narrow, demo-friendly REST layer on top of the existing tool/model internals.

## Route Prefix

All public routes are registered under:

- `/plugins/memory-public`

## Endpoints

- `GET /plugins/memory-public/health`
- `GET /plugins/memory-public/search?q=<query>&limit=<n>`
- `GET /plugins/memory-public/timeline?limit=<n>`
- `GET /plugins/memory-public/stats`
- `GET /plugins/memory-public/export?limit=<n>&narrativeLimit=<n>`
- `GET /plugins/memory-public/fact?id=<uuid>`

`/fact/:id` is supported as an equivalent when the gateway/router forwards path segments to the same handler.

## Export Bundle

`/export` returns a stable JSON bundle with:

- `manifest` (bundle version, plugin version, schema version, counts, limits)
- `version` metadata
- `facts`
- `episodes`
- `procedures`
- `narratives` (recent session/rollup narratives)
- `provenance.links` + `provenance.bySource`

This provides an inspectable, local-first export surface without requiring hosted memory.

## Quick Demo Flows

### 1) Search / timeline / inspect

```bash
curl "http://127.0.0.1:PORT/plugins/memory-public/search?q=deployment&limit=5"
curl "http://127.0.0.1:PORT/plugins/memory-public/timeline?limit=10"
curl "http://127.0.0.1:PORT/plugins/memory-public/fact?id=<fact-uuid>"
```

### 2) Stats + export snapshot

```bash
curl "http://127.0.0.1:PORT/plugins/memory-public/stats"
curl "http://127.0.0.1:PORT/plugins/memory-public/export?limit=100&narrativeLimit=20"
```

### 3) Store / search / forget loop

Use existing tools for mutation (`memory_store`, `memory_forget`) and public routes for fast, beginner-friendly inspection:

1. Store with `memory_store`
2. Verify with `/search` and `/fact`
3. Remove with `memory_forget`
4. Confirm removal with `/search`

This keeps the public REST layer narrow while preserving the richer tool model.
