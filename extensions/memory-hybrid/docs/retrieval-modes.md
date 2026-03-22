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
