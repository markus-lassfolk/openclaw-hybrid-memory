# Retrieval Modes

Issue #639 formalizes two retrieval paths with explicit module ownership.

## 1) Interactive Recall Path

- **Mode name:** `interactive-recall-path`
- **Owner:** `extensions/memory-hybrid/lifecycle/stage-recall.ts`
- **Contract:** latency-bounded hot path for chat turns
- **Policy highlights:**
  - strict stage timeout and vector-step timeout
  - budget capped by both `autoRecall.maxTokens` and `retrieval.ambientBudgetTokens`
  - HyDE/query expansion skipped by default when `queryExpansion.skipForInteractiveTurns=true`
  - graph expansion and LLM reranking are disallowed

## 2) Explicit/Deep Retrieval Path

- **Mode name:** `explicit-deep-retrieval-path`
- **Owner:** `extensions/memory-hybrid/services/retrieval-orchestrator.ts`
- **Contract:** richer retrieval for explicit tool requests and deeper analysis
- **Policy highlights:**
  - uses `retrieval.explicitBudgetTokens` by default
  - query expansion, graph strategy, RRF fusion, and reranking are allowed
  - graceful fallback behavior is preserved when enrichment steps fail

## Policy Source of Truth

`extensions/memory-hybrid/services/retrieval-mode-policy.ts` defines mode names and allowed behavior.
Both owner modules consume this file to avoid emergent, duplicated retrieval-policy logic.

