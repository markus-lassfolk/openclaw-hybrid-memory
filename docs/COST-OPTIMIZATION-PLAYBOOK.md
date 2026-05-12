---
layout: default
title: Cost Optimization Playbook
parent: Operations & Maintenance
nav_order: 10
---
# Cost Optimization Playbook

Practical rollout guide to reduce API/LLM spend while preserving memory quality.

---

## Goals

- Keep recall/capture quality high for daily use.
- Move expensive features to opt-in.
- Use cheap-first routing with safe fallbacks.
- Enforce ongoing cost checks.

---

## Recommended baseline profiles

### Profile A — Local-first (lowest cost)

Use when you want durable memory with near-zero variable model spend.

```json
{
  "mode": "local",
  "retrieval": { "strategies": ["fts5"] }
}
```

What you keep: auto-capture + auto-recall (FTS), WAL, durable SQLite memory.  
What you avoid: external embeddings and chat-model features.

### Profile B — Minimal (best value default)

Use for most production agents that still need semantic recall and low-cost maintenance.

```json
{
  "mode": "minimal",
  "distill": {
    "modelTier": "maintenance",
    "extractionModelTier": "nano"
  },
  "autoRecall": {
    "interactiveEnrichment": "fast",
    "maxTokens": 800
  }
}
```

### Profile C — Enhanced with guardrails

Use only for workflows that truly need reflection and richer behavior.

```json
{
  "mode": "enhanced",
  "distill": {
    "modelTier": "maintenance",
    "extractionModelTier": "nano"
  },
  "store": { "classifyBeforeWrite": false }
}
```

Enable expensive options (reranking, contextual variants, self-correction depth) only with clear business value.

---

## 10 implementation controls

1. **Mode by use-case**  
   Keep default agents on `local` or `minimal`; reserve `enhanced`/`complete` for specific teams or agents.

2. **Cheap-first tier routing**  
   Put the lowest-cost acceptable model first in `llm.nano` and `llm.maintenance`. Keep fallback chains, but avoid expensive first-choice entries.

3. **Distill extraction tier discipline**  
   Keep `distill.extractionModelTier` at `nano` (or `maintenance` when needed). Avoid `default`/`heavy` for routine extraction.

4. **Lean scheduled jobs**  
   Start with nightly distill + weekly reflection only. Disable optional cron chains until they show clear value.

5. **Local pre-filter before cloud distill**  
   Enable local pre-filtering for distill (`extraction.preFilter.enabled: true`) so low-signal sessions are skipped before cloud calls.

6. **Token budget tightening**  
   Tune down context budgets first:
   - `autoRecall.maxTokens` (start ~600–800)
   - `retrieval.ambientBudgetTokens`
   - `retrieval.explicitBudgetTokens`
   Prefer `interactiveEnrichment: "fast"` for stable low-cost turns.

7. **Avoid per-write classification by default**  
   Keep `store.classifyBeforeWrite: false` unless immediate write-time conflict resolution is required.

8. **Tiering discipline (HOT small, COLD deeper)**  
   Keep HOT compact (`memoryTiering.hotMaxTokens`, `hotMaxFacts`) and move low-value old content to COLD sooner.

9. **Local embeddings where feasible**  
   For high-volume installs, prefer `embedding.provider: "ollama"` or `"onnx"` and use cloud embedding as fallback via `embedding.preferredProviders`.

10. **Continuous cost guardrails**  
    Run weekly checks and keep cost tracking enabled:
    - `openclaw hybrid-mem stats --efficiency`
    - `openclaw hybrid-mem context-audit`
    - `openclaw hybrid-mem verify`
    Define spend/latency thresholds and downgrade feature sets when exceeded.

---

## Weekly operator checklist

1. Review top token sources with `context-audit`.
2. Review tier/source growth with `stats --efficiency`.
3. Confirm model routing and warnings with `verify`.
4. Trim or disable low-value scheduled jobs.
5. Re-check after changes within one week.

---

## Rollout order

1. Move all non-critical agents to `minimal` (or `local`).
2. Enforce cheap-first `llm.nano` and `llm.maintenance`.
3. Lock distill extraction to `nano`.
4. Enable/confirm distill local pre-filter.
5. Tighten recall budgets.
6. Disable per-write classification where not needed.
7. Tighten tiering limits (HOT smaller, COLD faster).
8. Migrate heavy-traffic environments to local embeddings.
9. Keep only high-value cron jobs.
10. Establish weekly guardrail review and rollback rules.

---

## Related docs

- [CONFIGURATION-MODES.md](CONFIGURATION-MODES.md)
- [FEATURES-AND-TIERS.md](FEATURES-AND-TIERS.md)
- [LLM-AND-PROVIDERS.md](LLM-AND-PROVIDERS.md)
- [OPERATIONS.md](OPERATIONS.md)
- [CLI-REFERENCE.md](CLI-REFERENCE.md)
