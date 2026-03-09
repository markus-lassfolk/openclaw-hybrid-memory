# Release notes — 2026.3.90 (2026-03-09)

This release follows **2026.3.72** (2026-03-07). Below is a detailed changelog and verbose release note summarizing everything that changed since the last release.

---

## Summary

**2026.3.90** is a major feature release implementing **Milestone A+B**: future-date decay protection, episodic event log (Layer 1), local embedding providers (Ollama/ONNX), multi-model embedding registry with RRF merge, contextual variants at index time, LLM query expansion, LLM re-ranking, verification store, provenance tracing, and document ingestion. It also adds real-time frustration detection, cross-agent learning, and tool effectiveness scoring (#263, #265), plus dependency updates.

---

## What changed since 2026.3.72

### Last release (2026.3.72)

- **Release workflow:** The "Set package version" step no longer fails when `package.json` already matches the release tag, avoiding `npm error Version not changed` on publish.

### New in 2026.3.90

#### Features (Milestone A+B)

1. **Future-date decay protection (#144)**  
   Facts that mention future dates (e.g. "Meeting on 2026-06-15") no longer expire before they become relevant. The plugin sets `decay_freeze_until` so decay is paused until that date.  
   - Config: `futureDateProtection.enabled` (default: `true`), `futureDateProtection.maxFreezeDays` (default: `365`; `0` = no limit).  
   - See CONFIGURATION.md § Future-date decay protection.

2. **Episodic event log — Layer 1 passive capture (#150)**  
   A new SQLite database `event-log.db` stores an append-only journal of session events: facts learned, decisions, actions, entities, preferences, corrections. This is the raw input for the Dream Cycle consolidation pipeline.  
   - API: `append()`, `appendBatch()`, `getBySession()`, `getByTimeRange()`, `getUnconsolidated()`, `getByEntity()`, `markConsolidated()`, `archiveConsolidated()`, `getStats()`.  
   - Config: `eventLog.archivalDays` (default: 90), `eventLog.archivePath`.  
   - See `extensions/memory-hybrid/docs/event-log.md`.

3. **Local embedding providers — Ollama / ONNX (#153)**  
   Embeddings can use local models without API keys:  
   - **Ollama:** Connects to a running Ollama server (default `http://localhost:11434`).  
   - **ONNX:** In-process inference via `@xenova/transformers`.  
   - Config: `embedding.provider` (`openai` | `google` | `ollama` | `onnx`), `embedding.model` / `embedding.ollamaModel` / `embedding.onnxModelPath`, `embedding.endpoint`, `embedding.autoMigrate`.  
   - See CONFIGURATION.md § Local embedding providers.

4. **Multi-model embedding registry + RRF merge (#158)**  
   Facts can be embedded with multiple models at once. At recall time, each model returns a ranked list; Reciprocal Rank Fusion (RRF) merges them so results that rank well across models rise to the top. You can mix OpenAI, Ollama, and ONNX.  
   - Config: `embedding.multiModels` array of `{ name, provider, dimensions, role }`.  
   - See CONFIGURATION.md § Multi-model embedding registry.

5. **Contextual variants at index time (#159)**  
   An optional cheap LLM generates alternative phrasings of each fact; those variants are embedded and stored as extra LanceDB vectors. Recall improves for paraphrased queries without query-time expansion.  
   - Config: `contextualVariants.enabled`, `contextualVariants.model`, `contextualVariants.maxVariantsPerFact` (default: 2, max: 5), `contextualVariants.maxPerMinute` (default: 30), `contextualVariants.categories`.  
   - See CONFIGURATION.md § Contextual variants.

6. **Query expansion via LLM (#160)**  
   Before embedding a retrieval query, a cheap LLM can expand it into multiple variants (hypothetical answer or paraphrase). All variants are embedded and merged before RRF. Modes: `always`, `conditional` (only when initial score is below threshold), `off`. Includes an LRU cache. Replaces deprecated `search.hydeEnabled` / `search.hydeModel`.  
   - Config: `queryExpansion.enabled`, `queryExpansion.mode`, `queryExpansion.threshold`, `queryExpansion.model`, `queryExpansion.maxVariants` (default: 4), `queryExpansion.cacheSize` (default: 100), `queryExpansion.timeoutMs` (default: 5000).  
   - See CONFIGURATION.md § Query expansion.

7. **LLM re-ranking (#161)**  
   After RRF, the top-N candidates can be re-ordered by an LLM for better semantic relevance. On timeout or LLM failure, the original RRF order is used.  
   - Config: `reranking.enabled`, `reranking.model`, `reranking.candidateCount` (default: 50), `reranking.outputCount` (default: 20), `reranking.timeoutMs` (default: 10000).  
   - See CONFIGURATION.md § LLM re-ranking.

8. **Verification store (#162)**  
   Critical facts can be enrolled in a verification store: append-only backup to `verified-facts.json` and scheduled re-verification. `autoClassify: true` (default) auto-enrolls facts tagged as `critical`.  
   - Tools: `memory_verify`, `memory_verified_list`, `memory_verification_status`.  
   - Config: `verification.enabled`, `verification.backupPath`, `verification.reverificationDays` (default: 30), `verification.autoClassify`, `verification.continuousVerification`, `verification.cycleDays` (default: 30), `verification.verificationModel`.  
   - See CONFIGURATION.md § Verification store.

9. **Provenance tracing (#163)**  
   Optional full origin chain for every fact: session, episodic events, and consolidated-from facts. Stored in `provenance.db` with `DERIVED_FROM` and `CONSOLIDATED_FROM` edges.  
   - Tool: `memory_provenance(factId)` — chain up to 10 hops.  
   - Config: `provenance.enabled` (default: false), `provenance.retentionDays` (default: 365).  
   - See CONFIGURATION.md § Provenance tracing.

10. **Document ingestion (#206)**  
    New tools `memory_ingest_document` and `memory_ingest_folder`: convert PDF, DOCX, PPTX, XLSX, HTML, Markdown, CSV, EPUB, images, etc. to Markdown via MarkItDown Python bridge, chunk, and store as facts.  
    - Features: SHA-256 hash dedup, progress callbacks `{ stage, pct, message }`, optional LLM vision for images, path allowlist.  
    - Config: `documents.enabled` (default: false), `documents.pythonPath`, `documents.chunkSize` (default: 2000), `documents.chunkOverlap` (default: 200), `documents.maxDocumentSize` (default: 50 MB), `documents.autoTag`, `documents.visionEnabled`, `documents.visionModel`, `documents.allowedPaths`. Requires `pip install markitdown`.  
    - See CONFIGURATION.md § Document ingestion.

#### Behavior and tooling

- **Real-time frustration detection, cross-agent learning, tool effectiveness (#263, #265)**  
  Frustration signals in user messages are detected in real time; cross-agent learning and tool effectiveness scoring improve recall and tool recommendations.

#### Documentation

- **CONFIGURATION.md:** New sections for all 10 Milestone A+B features (#144–#206) and query expansion (#160).
- **FEATURES.md:** Feature table updated with links to CONFIGURATION.md.
- **CLI-REFERENCE.md:** Commands-by-category table; run-all, generate-proposals, scope list/stats/prune/promote, active-tasks; full table of 9 maintenance cron jobs; verify --fix.
- **cron-jobs.ts:** In sync with `handlers.ts`; comment that canonical source is `MAINTENANCE_CRON_JOBS` in handlers.

#### Other

- **Dependencies:** Minor and patch bumps (minor-and-patch group, #266).

---

## Upgrade

From a previous OpenClaw Hybrid Memory install:

```bash
openclaw hybrid-mem upgrade 2026.3.90
```

Clean install:

```bash
npx -y openclaw-hybrid-memory-install 2026.3.90
```

Restart the gateway after upgrading.

---

## References

- **Changelog:** [CHANGELOG.md](../CHANGELOG.md) — full history and links.
- **Compare:** [v2026.3.72...v2026.3.90](https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.3.72...v2026.3.90).
