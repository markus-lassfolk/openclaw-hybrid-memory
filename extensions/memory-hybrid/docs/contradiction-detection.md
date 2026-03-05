# Contradiction Detection

**Issue #157** — Detects conflicting facts at write time, marks them in retrieval, and provides a resolution foundation for the Dream Cycle (#143).

## Overview

When a new fact is stored with the same `entity` + `key` as an existing fact but a **different `value`**, the system automatically:

1. Records a contradiction in the `contradictions` table.
2. Creates a `CONTRADICTS` link in `memory_links` (new → old).
3. Reduces confidence on the older fact by 0.2 (floor: 0.1).
4. Logs a `correction` event to the event log.

Same-value updates are treated as **reinforcement** (no contradiction).

---

## How Detection Works

### Exact Entity + Key Match

Detection fires when:
- `entity`, `key`, and `value` are all non-empty on the new fact.
- An active (non-superseded, non-expired) fact exists with:
  - `lower(entity)` = `lower(newEntity)`
  - `lower(key)` = `lower(newKey)`
  - `lower(value)` ≠ `lower(newValue)`

If the values match (case-insensitive), no contradiction is recorded — the new fact is a **reinforcement**.

### Semantic Similarity (Foundation)

Full semantic near-duplicate detection via vector similarity is a future enhancement (#143 Dream Cycle). The current implementation provides the structural foundation (CONTRADICTS links + contradictions table) that semantic detection will populate.

---

## Data Model

### `contradictions` Table

| Column | Type | Description |
|---|---|---|
| `id` | TEXT | UUID primary key |
| `fact_id_new` | TEXT | Incoming (contradicting) fact id |
| `fact_id_old` | TEXT | Existing (contradicted) fact id |
| `detected_at` | TEXT | ISO timestamp of detection |
| `resolved` | INTEGER | 0 = unresolved, 1 = resolved |
| `resolution` | TEXT | `superseded` / `kept` / `merged` / NULL |

### `memory_links` Table (CONTRADICTS entries)

A `CONTRADICTS` link is created in `memory_links` from `fact_id_new` → `fact_id_old` with `strength = 1.0`. This integrates with the existing graph traversal system.

---

## Resolution Strategies

| Strategy | When to use |
|---|---|
| `superseded` | New fact definitively replaces the old one |
| `kept` | Old fact is retained (new fact was wrong/irrelevant) |
| `merged` | Both facts are partially correct; merge is needed |

---

## How Contradictions Appear in Retrieval

When `memory_recall` returns results, facts that are the target of an unresolved `CONTRADICTS` link are annotated with **`[⚠️ CONTRADICTED]`** in the text output:

```
1. [sqlite/preference] [⚠️ CONTRADICTED] User prefers dark mode (72%)
2. [sqlite/preference] User switched to light mode (88%)
```

The `contradicted: true` flag also appears in the structured `details.memories` array, allowing consumers to programmatically detect and handle contradicted facts.

Contradicted facts naturally rank lower due to reduced confidence, which flows through the RRF confidence multiplier.

---

## Nightly Resolution Stub

`resolveContradictions()` on `FactsDB` runs nightly (foundation for #143):

1. Fetches all **unresolved** contradiction pairs.
2. **Auto-supersedes** when the new fact is:
   - Newer (`createdAt >=` old)
   - Higher confidence
   - From an explicit user store (`source = 'conversation'` or `'cli'`)
3. Returns **ambiguous** pairs for future LLM resolution (#143 Dream Cycle).

### Return value

```typescript
{
  autoResolved: Array<{ contradictionId, factIdNew, factIdOld }>;
  ambiguous:    Array<{ contradictionId, factIdNew, factIdOld }>;
}
```

---

## API Reference

### `FactsDB` Methods

```typescript
// Detect and record contradictions for a newly stored fact.
detectContradictions(
  newFactId: string,
  entity: string | null | undefined,
  key:    string | null | undefined,
  value:  string | null | undefined,
): Array<{ contradictionId: string; oldFactId: string }>

// Low-level: record one contradiction (link + confidence update).
recordContradiction(factIdNew: string, factIdOld: string): string

// Find active facts with same entity+key but different value.
findConflictingFacts(entity, key, value, excludeFactId): MemoryEntry[]

// Update confidence with delta (floor 0.1, cap 1.0).
updateConfidence(id: string, delta: number): number | null

// Check if a fact is the target of any unresolved CONTRADICTS link.
isContradicted(factId: string): boolean

// Get contradiction records (all unresolved, or filtered by factId).
getContradictions(factId?: string): ContradictionRecord[]

// Mark a contradiction resolved.
resolveContradiction(id: string, resolution: 'superseded'|'kept'|'merged'): boolean

// Nightly batch resolution stub.
resolveContradictions(): { autoResolved: [...]; ambiguous: [...] }

// Count unresolved contradictions.
contradictionsCount(): number
```

### `ContradictionRecord` Type

```typescript
interface ContradictionRecord {
  id:          string;
  factIdNew:   string;
  factIdOld:   string;
  detectedAt:  string;   // ISO timestamp
  resolved:    boolean;
  resolution:  'superseded' | 'kept' | 'merged' | null;
}
```

---

## Event Log Integration

Each detected contradiction is logged as a `correction` event:

```json
{
  "eventType": "correction",
  "content": {
    "type": "contradiction_detected",
    "contradictionId": "<uuid>",
    "newFactId": "<uuid>",
    "oldFactId": "<uuid>",
    "entity": "user",
    "key": "theme",
    "newValue": "light"
  },
  "entities": ["user"]
}
```

---

## Future Work

- **#143 Dream Cycle**: LLM-assisted resolution for ambiguous contradiction pairs returned by `resolveContradictions()`.
- **Semantic similarity detection**: Flag near-duplicate facts with differing content (cosine > 0.85, same entity) as potential contradictions.
