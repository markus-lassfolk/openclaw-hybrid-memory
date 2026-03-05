# RRF Retrieval Pipeline

Issue #152 — Multi-strategy retrieval with Reciprocal Rank Fusion.

## Overview

The RRF retrieval pipeline combines results from multiple independent search
strategies into a single ranked list. Strategies run in parallel, their results
are fused using Reciprocal Rank Fusion (RRF), and post-RRF score adjustments
are applied before results are packed into a token budget.

```
Query
  │
  ├── FTS5 search ──────────────────────────┐
  │                                          │
  ├── Semantic (vector) search ─────────────┤→ RRF Fusion → Post-RRF Adjustments → Token Budget Packing
  │                                          │
  └── Graph walk (stub → #145) ─────────────┘
```

## The Three Retrieval Strategies

### 1. FTS5 (Full-Text Search)

Uses SQLite's FTS5 BM25-ranked full-text search over fact text, category,
entity, tags, key, and value columns. Fast, exact keyword matching.
See `docs/fts-search.md` and `services/fts-search.ts`.

### 2. Semantic (Vector) Search

Uses LanceDB cosine similarity over OpenAI text embeddings. Finds facts that
are semantically related even without exact keyword overlap.

Supports HyDE (Hypothetical Document Embedding) when `search.hydeEnabled` is
true: a small LLM generates a hypothetical answer before embedding, often
improving retrieval of indirect answers.

### 3. Graph Walk (stub)

Placeholder for the spreading-activation GraphRAG strategy planned in issue
#145. Currently returns empty results. When implemented, it will walk the
entity relationship graph to discover connected facts.

## RRF Algorithm

Reciprocal Rank Fusion (Cormack et al., 2009) combines ranked lists without
requiring score normalization between strategies.

### Formula

For each fact `f` that appears in one or more strategy result lists:

```
rrf_score(f) = Σ  1 / (k + rank_i)
               i
```

where `rank_i` is the 1-based position of `f` in strategy `i`'s ranked list,
and `k` is a constant (default 60).

### Example

| Fact    | Semantic rank | FTS5 rank | RRF score (k=60)                  |
|---------|--------------|-----------|-----------------------------------|
| fact-A  | 1            | 1         | 1/61 + 1/61 ≈ 0.0328             |
| fact-B  | 2            | —         | 1/62 ≈ 0.0161                    |
| fact-C  | —            | 2         | 1/62 ≈ 0.0161                    |
| fact-D  | 1 (only)     | —         | 1/61 ≈ 0.0164                    |

fact-A ranks highest because it appears in both strategies. fact-D would rank
above fact-B and fact-C because its single rank-1 result yields a higher score
than a rank-2 result.

### Why k=60?

The constant `k=60` is the standard value from the original RRF paper. Higher
`k` reduces the score advantage of top-ranked items, making the fusion more
forgiving of rank differences. Lower `k` sharpens the advantage of being
ranked first.

## Post-RRF Score Adjustments

After fusion, three multiplicative adjustments are applied to each result's
`rrfScore` to produce the `finalScore`:

### Recency

```
score *= 1 + log(days_since_last_access + 1) * -0.01
```

Facts that haven't been accessed recently are slightly down-weighted.

- Accessed today: multiplier = 1.0 (neutral)
- Accessed 30 days ago: multiplier ≈ 0.966
- Never accessed (`lastAccessed` is null): treated as today (neutral)

### Confidence

```
score *= confidence
```

Facts with lower confidence scores (0–1) are down-weighted proportionally.
Default confidence for new facts is 1.0.

### Access Frequency

```
score *= 1 + min(recallCount * 0.02, 0.2)
```

Facts that have been recalled more often receive a small boost, capped at +20%.

- `recallCount = 0`: multiplier = 1.0
- `recallCount = 5`: multiplier = 1.10 (+10%)
- `recallCount = 10+`: multiplier = 1.20 (+20%, capped)

## Token Budget Packing

After ranking, facts are serialized and packed into a token budget.

### Serialization format

Each fact is serialized as:

```
[entity: X | category: Y | confidence: 0.95 | stored: 2026-02-15]
Fact text here.
```

The `entity` field is omitted when null.

### Packing algorithm

1. Iterate facts from highest `finalScore` to lowest.
2. Estimate tokens for each serialized fact using `ceil(chars / 4)`.
3. Add the fact to the packed list if it fits within the remaining budget.
4. Stop when the budget is exhausted.

### Budgets

| Mode       | Default tokens | Config key              |
|------------|---------------|-------------------------|
| Ambient    | 2000          | `retrieval.ambientBudgetTokens` |
| Explicit   | 4000          | `retrieval.explicitBudgetTokens` |

The `memory_recall` tool uses the **explicit** budget. Auto-recall injection
uses the **ambient** budget.

## Configuration Reference

```yaml
hybridMemory:
  retrieval:
    # Active retrieval strategies (order doesn't affect scoring)
    strategies: ['semantic', 'fts5', 'graph']

    # RRF k constant (default 60, standard from Cormack et al.)
    rrf_k: 60

    # Token budget for ambient auto-recall context injection
    ambientBudgetTokens: 2000

    # Token budget for explicit memory_recall tool results
    explicitBudgetTokens: 4000

    # Max hops for graph walk (future #145 feature)
    graphWalkDepth: 2

    # Top-K candidates per strategy fed into RRF
    semanticTopK: 20
```

### Disabling a strategy

Remove it from `strategies`:

```yaml
retrieval:
  strategies: ['semantic', 'fts5']  # no graph
```

### Tuning for speed

Reduce `semanticTopK` to limit the number of vector search candidates:

```yaml
retrieval:
  semanticTopK: 10
```

### Tuning for recall

Increase `semanticTopK` and token budgets:

```yaml
retrieval:
  semanticTopK: 40
  explicitBudgetTokens: 8000
```

## Implementation Files

| File | Purpose |
|------|---------|
| `services/rrf-fusion.ts` | RRF algorithm and post-RRF adjustments |
| `services/retrieval-orchestrator.ts` | Multi-strategy orchestrator and token budget packing |
| `services/fts-search.ts` | FTS5 full-text search strategy |
| `tests/rrf-fusion.test.ts` | Unit tests for all pipeline components |
| `config.ts` | `RetrievalConfig` type and config parsing |
