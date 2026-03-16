# Features and model tiers

This document lists LLM-using (and related) features: what each does, which modes enable it, and which **model tier** is used so you can balance value and cost. Tiers are **nano** (cheapest, short/simple tasks), **default** (flash-class, general), and **heavy** (larger context, complex analysis).

**Mode defaults:** Local = no external LLM. Minimal = nano for classify, default (flash) for distill. Enhanced/Complete add more features; we still use nano or default where that’s enough for value.

---

## How to read the Modes column

- **"Local, Minimal, Enhanced, Complete"** — The **preset** for that mode turns the feature **on**. (Example: auto-capture is on in all modes.)
- **"Minimal, Enhanced, Complete"** — The preset turns it on only in those modes; in Local the preset leaves it off.
- **"Enhanced, Complete"** — The preset turns it on only in Enhanced and Complete; in Local and Minimal the preset leaves it off.
- **"Enhanced, Complete (opt-in)"** — The feature is **available** in Enhanced and Complete, but the **preset still leaves it off** in those modes. You opt in by setting the feature's config yourself (e.g. `personaProposals.enabled: true`). So: **opt-in = off by default even in Enhanced/Complete**; you must enable it explicitly if you want it.
- **"Complete (opt-in)"** — Same idea: available in Complete, preset leaves it off, you enable it explicitly.

**You can enable any feature in any mode.** Mode only applies a preset; any key you set in config overrides the preset. So you can stay in **Local** or **Minimal** and turn on e.g. persona proposals or dream cycle by setting `personaProposals.enabled: true` or `nightlyCycle.enabled: true`. You do **not** have to switch to Enhanced first. See [CONFIGURATION-MODES.md § Overriding the preset](CONFIGURATION-MODES.md#overriding-the-preset).

---

## Feature matrix


| Feature                       | Short description                                                    | Modes                                             | Tier                                                                                                 | Notes                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Auto-capture**              | Extract facts, preferences, decisions from conversation turns        | Local, Minimal, Enhanced, Complete                | —                                                                                                    | Rule-based extraction; no LLM in core path.                                                            |
| **Auto-recall**               | Inject relevant memories into the prompt each turn                   | Local, Minimal, Enhanced, Complete                | —                                                                                                    | Uses embeddings + FTS (Local: FTS only). No per-turn LLM unless optional features below are on.        |
| **Embeddings**                | Vectorize facts for semantic search                                  | Minimal, Enhanced, Complete                       | —                                                                                                    | Local mode is FTS-only (no embeddings).                                                                |
| **Distill**                   | Turn session logs into structured facts (batch)                      | Minimal, Enhanced, Complete                       | **Minimal: default (flash)**. Enhanced/Complete: **default** (config: `distill.extractionModelTier`) | Flash gives better extraction quality; nano is cheaper. Minimal preset uses default (flash) for value. |
| **Auto-classify**             | Assign category (preference, fact, decision, entity, other) to facts | Minimal, Enhanced, Complete                       | **nano**                                                                                             | Simple classification; nano is sufficient.                                                             |
| **Classify-before-write**     | Classify at store time instead of batch                              | Enhanced, Complete                                | **nano**                                                                                             | Same as auto-classify; one call per store.                                                             |
| **Query expansion**           | Expand user query with LLM before embedding (better recall)          | Complete (opt-in)                                 | **nano**                                                                                             | One nano call per recall; improves relevance.                                                          |
| **Summarize (recall)**        | Shorten long facts for injection                                     | Minimal, Enhanced, Complete (when recall enabled) | **nano**                                                                                             | Token saving; nano is enough.                                                                          |
| **Reranking**                 | Re-rank recalled results with LLM                                    | Complete (opt-in)                                 | **nano**                                                                                             | Improves order; nano is sufficient.                                                                    |
| **Contextual variants**       | Generate alternate phrasings for recall                              | Complete (opt-in)                                 | **nano**                                                                                             | Nano default.                                                                                          |
| **Reflection**                | Extract patterns from recent facts                                   | Enhanced, Complete                                | **default**                                                                                          | Needs coherent reasoning; default (flash) is the right tier.                                           |
| **Reflect-rules**             | Turn patterns into rules                                             | Enhanced, Complete                                | **default**                                                                                          | Same.                                                                                                  |
| **Reflect-meta**              | Meta-patterns from rules                                             | Enhanced, Complete                                | **default**                                                                                          | Same.                                                                                                  |
| **Extract-procedures**        | Extract procedures from session tool use                             | Enhanced, Complete                                | **default**                                                                                          | Structured extraction; default is enough.                                                              |
| **Extract-directives**        | Extract directive rules from sessions                                | Minimal, Enhanced, Complete                       | Same as **Distill** (distill’s tier)                                                                 | Part of distill pipeline.                                                                              |
| **Extract-reinforcement**     | Extract reinforcement from praise                                    | Minimal, Enhanced, Complete                       | Same as **Distill**                                                                                  | Part of distill pipeline.                                                                              |
| **Self-correction**           | Analyze failures, suggest TOOLS/AGENTS fixes                         | Enhanced, Complete                                | **heavy**                                                                                            | Deep analysis; heavy tier by design.                                                                   |
| **Entity lookup**             | Resolve entity mentions for targeted recall                          | Enhanced, Complete                                | —                                                                                                    | Uses embedding + search; no separate LLM.                                                              |
| **Language keywords (build)** | Build trigger phrases for self-correction                            | Minimal, Enhanced, Complete                       | **nano**                                                                                             | Short, structured; nano.                                                                               |
| **Suggest categories**        | Propose new categories from data                                     | Minimal, Enhanced, Complete                       | **nano**                                                                                             | Same as auto-classify.                                                                                 |
| **Retrieval aliases**         | Generate aliases for entities                                        | Enhanced, Complete (opt-in)                       | **nano**                                                                                             | Nano.                                                                                                  |
| **Persona proposals**         | Propose identity updates from reflection                             | Enhanced, Complete (opt-in)                       | **default**                                                                                          | One summary step; default is enough.                                                                   |
| **Dream cycle**               | Nightly: prune, consolidate, reflect, reflect-rules                  | Enhanced, Complete (opt-in)                       | **default** (reflection steps)                                                                       | No LLM for prune/consolidate; reflection uses default.                                                 |
| **Consolidate**               | Merge duplicate facts with LLM                                       | Enhanced, Complete                                | **default**                                                                                          | Uses default tier; pass `--model` to override.                                                         |
| **Generate proposals**        | Persona proposals from reflection                                    | Enhanced, Complete (opt-in)                       | **default**                                                                                          | Same as persona proposals.                                                                             |
| **Ingest (files)**            | Extract facts from workspace Markdown                                | Minimal, Enhanced, Complete                        | **default**                                                                                          | File → facts; default. On-demand (run ingest-files).                                                   |
| **Documents (MarkItDown)**    | Ingest PDF, DOCX, etc. via MarkItDown                                | Complete                                          | **default** (vision from llm.default)                                                                | No LLM for PDF/DOCX (chunk+embed only). Optional vision for images.                                   |
| **Passive observer**          | Score sessions for interest (pre-filter)                             | Enhanced, Complete (opt-in)                       | **nano**                                                                                             | Lightweight triage.                                                                                    |
| **Cross-agent learning**      | Generalize lessons across agents                                     | Enhanced, Complete (opt-in)                       | **default**                                                                                          | One model in code; default tier.                                                                       |


---

## Tier summary

- **nano**: Auto-classify, classify-before-write, query expansion, summarize, reranking, contextual variants, language keywords, suggest categories, retrieval aliases, passive observer. Use for short, classification-style or lightweight generation tasks.
- **default (flash)**: Distill (in Minimal and typically in Enhanced/Complete), reflection (all steps), extract-procedures, persona proposals, dream cycle (reflection parts), consolidate, ingest, documents, cross-agent learning. Use for general extraction, synthesis, and multi-step reasoning that doesn’t need the largest context.
- **heavy**: Self-correction. Use only where deep analysis and large context pay off.

---

## See also

- [CONFIGURATION-MODES.md](CONFIGURATION-MODES.md) — What each mode enables.
- [CONFIGURATION.md](CONFIGURATION.md) — Full config reference and `llm.nano` / `llm.default` / `llm.heavy`.

