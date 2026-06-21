# Release notes — OpenClaw Hybrid Memory **2026.6.171**

**Release date:** 2026-06-21  
**Since:** [2026.6.170](CHANGELOG.md#20266170---2026-06-17)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.6.171]**

## Highlights

Fixes the hybrid-memory recall / search smoke failures observed in the
Maeve OpenClaw main session on 2026-06-21 while investigating gateway
memory/RSS incidents:

- **`memory_search_episodes` no longer throws `sanitizeFts5QueryForFacts is not defined`.**
  `backends/facts-db/episodes.ts` referenced the FTS5 query sanitizer
  (`sanitizeFts5QueryForFacts` from `backends/facts-db/fts-text.ts`) without
  importing it, so the symbol was undefined at runtime and any episode
  search that supplied a query exploded. The import is now wired up
  alongside the existing sibling in `fact-queries.ts`, and episode search
  is covered by new smoke tests (plain query, special-character query,
  null bytes, FTS5 operators).

- **`memory_recall_timeline` no longer requires `api.context.sessionId`.**
  When invoked from the normal OpenClaw gateway tool context (which does
  not inject an authenticated sessionId), the tool previously threw
  `memory_recall_timeline requires an authenticated session context`. It
  now falls back to cross-session timeline recall (recency-windowed,
  default 14 days — the same path `recallNarrativeSummaries` already
  supports natively with `sessionId: null`). The existing security
  invariant is preserved: a caller-supplied `sessionId` is still rejected
  when no authenticated context is available, and must still match the
  authenticated context when one is present.

- **`memory_session_observability` returns an actionable error.**
  Per-session observability has no cross-session equivalent, so it
  cannot fall back the same way. The error message now explains how to
  recover (pass `sessionId` as a parameter or invoke from an
  authenticated session context).

This supports the OpenClaw gateway memory/RSS incident follow-up: hybrid
memory is the canonical memory layer, so the recall / timeline / episode
search smoke must be reliable.

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.6.171
```

Restart the gateway after upgrading. Align `openclaw-hybrid-memory-install` to **2026.6.171** if you use the installer package.
