# Retrieval Modes

This extension now treats retrieval as two intentional modes with clear ownership.

## 1. Interactive recall path

**Owner:** `lifecycle/stage-recall.ts`

Use this path for chat-turn auto-recall and other latency-sensitive injection work.

### Contract
- bounded for the hot path
- strict stage timeout and vector-step timeout
- predictable fallback to degraded FTS-only/HOT recall under pressure
- advanced enrichment is off by default

### Allowed behavior
- FTS recall
- bounded semantic recall
- ambient multi-query only when the interactive path explicitly enables it
- entity and procedure augmentation already owned by the lifecycle stage

### Disallowed-by-default behavior
- HyDE / expensive LLM query rewriting
- deep fusion ownership
- richer reranking orchestration

## 2. Explicit/deep retrieval path

**Owner:** `services/retrieval-orchestrator.ts`

Use this path for explicit tool requests such as `memory_recall`, maintenance flows, and deeper analysis.

### Contract
- richer orchestration is acceptable
- retrieval quality can spend more latency budget
- owns query preparation, fusion, and packing budget policy

### Allowed behavior
- HyDE / LLM query expansion
- RRF fusion
- alias expansion
- graph expansion
- multi-model semantic retrieval
- reranking
- packing to `retrieval.explicitBudgetTokens`

## Ownership summary
- `lifecycle/stage-recall.ts` owns the **interactive recall path**
- `services/retrieval-orchestrator.ts` owns the **explicit/deep retrieval path**
- `services/retrieval-mode-policy.ts` names both modes and defines the default contracts

This split is meant to optimize maintainability and runtime predictability, not just move code around.

## 3. Constrained-recall path (filter → rank → hydrate)

**Owner:** `services/retrieval-orchestrator.ts`

Introduced for Issue #1026. Use this path when you need to search *within a known boundary* — e.g., facts about a specific project, from the last 30 days, or only verified memories.

### Pattern: filter → rank → hydrate

```
structured filters (SQL)
    ↓
vector / FTS ranking within candidate set
    ↓
hydrate with provenance, graph context, supersession state, explanation
```

### Contrast with explicit-deep

| | explicit-deep | constrained-recall |
|---|---|---|
| Candidate set | All facts | Pre-filtered via SQL |
| Fusion | RRF across all strategies | Ranked by semantic score only |
| Graph expansion | Yes | No |
| HyDE | Yes | Yes |
| Use case | Open-ended search | Bounded precision recall |

### ConstrainedSearchFilters

Available structured filters (all optional):
- `entity` — exact entity name match
- `tag` — LIKE %tag% match
- `category` — exact category match
- `scope` / `scopeTarget` — exact scope match
- `verificationTier` — only verified facts of a given tier
- `validFromSec` / `validUntilSec` — temporal window
- `tier` — hot/warm/cold
- `sourceSession` — limit to a specific session

### Example usage

```typescript
const result = await runExplicitDeepRetrieval(
  "API key rotation",
  queryVector,
  db,
  vectorDb,
  factsDb,
  {
    mode: "constrained-recall",
    constrainedFilters: {
      entity: "openclaw-hybrid-memory",
      validFromSec: Date.now() / 1000 - 30 * 86400, // last 30 days
      verificationTier: "critical",
    },
  },
);
```

### Good use cases

- "show facts about project X from the last 30 days"
- "search only verified infra-related memories"
- "find session notes linked to this entity"
- "search within one imported document or source domain"

### What it does not replace

- Broader graph or semantic recall without constraints
- Interactive recall (use `mode: "interactive-recall"` for that)
