# Memory Tiering (FR-004) — Hot / Warm / Cold

Dynamic memory tiering reduces retrieval cost and token usage by separating memories into three tiers. Only HOT and WARM are searched by default; COLD is archived and retrieved only when explicitly requested.

---

## Tiers

| Tier | Purpose | When loaded / searched |
|------|---------|------------------------|
| **HOT** | Current session context (active blockers, pinned items) | Always injected at session start, capped at &lt;2k tokens (configurable). Not from vector search. |
| **WARM** | Recently accessed facts and projects | Default target for FTS5 + LanceDB semantic search on each turn. |
| **COLD** | Archived knowledge (completed tasks, old decisions) | Excluded from default search. Use `memory_recall(..., includeCold: true)` or CLI `search` with tier filter to query. |

---

## Behavior

- **New facts** are stored with tier **WARM** unless you pass `tier` when storing.
- **Auto-recall (before_agent_start):** Injects HOT facts first (up to `memoryTiering.hotMaxTokens`), then runs semantic search over **WARM** only. COLD is never included unless you enable “include cold” (see below).
- **memory_recall tool:** By default searches HOT + WARM. Set **`includeCold: true`** to include COLD tier (slower / deeper retrieval as per the feature request).
- **Compaction** migrates facts between tiers (see below). It runs automatically at **agent_end** when `memoryTiering.compactionOnSessionEnd` is true, or manually via **`openclaw hybrid-mem compact`**.

---

## Compaction rules

When compaction runs (session end or CLI):

1. **Completed tasks → COLD**  
   Facts with category `decision` or tag `task` are moved to COLD.

2. **Inactive preferences → WARM**  
   Facts with category `preference` that are currently HOT and have not been accessed within `inactivePreferenceDays` (default 7) are moved to WARM.

3. **Active blockers → HOT**  
   Facts with tag `blocker` are moved to HOT, up to the cap defined by `hotMaxTokens` and `hotMaxFacts` (so the HOT tier stays small).

4. **Demote non-blockers from HOT**  
   Any fact in HOT that is not a blocker is moved back to WARM so HOT stays focused.

---

## Configuration

See [CONFIGURATION.md](CONFIGURATION.md#fr-004-memory-tiering-hotwarmcold) for the full `memoryTiering` block. Summary:

- **hotMaxTokens** (default 2000) — Token budget for the HOT block at session start.
- **compactionOnSessionEnd** (default true) — Run compaction when the agent session ends.
- **inactivePreferenceDays** (default 7) — Days without access after which a HOT preference is moved to WARM.
- **hotMaxFacts** (default 50) — Maximum number of facts in HOT when promoting blockers.

---

## CLI

- **`openclaw hybrid-mem compact`** — Run tier compaction now. Prints counts of facts moved to hot, warm, and cold.

---

## Tags and categories used by compaction

- **Tag `blocker`** — Treated as “active blocker”; compaction can promote to HOT (subject to caps).
- **Tag `task`** — Treated as task-related; compaction can move to COLD (with category `decision`).
- **Category `decision`** — Treated as completed task; compaction moves to COLD.
- **Category `preference`** — If in HOT and inactive (by days), compaction moves to WARM.

---

## Related

- [CONFIGURATION.md](CONFIGURATION.md) — `memoryTiering` config block
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — `hybrid-mem compact`
- [FEATURES.md](FEATURES.md) — Feature index
