---
layout: default
title: Search improvements (RRF, ingest-files, HyDE)
parent: Features
nav_order: 14
---
# Search Improvements — RRF, ingest-files, HyDE

[GitHub issue #33](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/33) adds three improvements to hybrid memory search:

1. **Reciprocal Rank Fusion (RRF)** — Better merging of SQLite FTS5 and LanceDB vector results
2. **`ingest-files`** — Index workspace markdown (skills, TOOLS.md, etc.) as searchable facts
3. **HyDE** — Hypothetical Document Embeddings for query expansion (opt-in)

---

## Reciprocal Rank Fusion (RRF)

RRF is the core search improvement in this release. It replaces a naive score-based merge with a
rank-based algorithm that correctly combines BM25 keyword scores and cosine similarity scores —
two metrics that are otherwise not comparable.

### Search pipeline

```
                         ┌──────────────────────────┐
                         │         query            │
                         └───────────┬──────────────┘
                                     │
               ┌─────────────────────┴─────────────────────┐
               ▼                                           ▼
   ┌───────────────────────┐               ┌───────────────────────┐
   │  SQLite FTS5 (BM25)   │               │  LanceDB (cosine sim) │
   │  keyword search       │               │  vector search        │
   └───────────┬───────────┘               └───────────┬───────────┘
               │                                       │
               └─────────────────┬─────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │    RRF score merge       │
                    │  score = Σ 1/(k + rank) │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  Dedup (ID + text)       │
                    │  SQLite wins ties        │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  Superseded filter       │
                    │  (via SupersededProvider)│
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  Scope filter            │
                    │  (user/agent/session)    │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │        results           │
                    └─────────────────────────┘
```

### Problem

The previous merge logic combined SQLite BM25 scores and LanceDB cosine similarity by sorting on raw `score`. Those metrics are on incompatible scales (e.g. BM25 ~8.5 vs cosine ~0.82), so mixing them produced poor ranking.

### Solution

**Reciprocal Rank Fusion** (Cormack et al., 2009) uses ranks instead of raw scores:

1. Rank SQLite results by BM25 score descending (best = rank 1).
2. Rank LanceDB results by cosine similarity descending.
3. For each unique fact: `rrf_score = Σ 1/(k + rank)` over all lists it appears in.
4. Sort by `rrf_score` descending.

Facts that rank well in **both** keyword and semantic search get higher RRF scores and rise to the top. No score normalization needed.

### Default behaviour

RRF is always on. No config change required. The constant `k=60` is standard in IR literature.

### Deduplication strategy

Before RRF scores are computed, results from both backends are deduplicated using two passes:

1. **ID-based dedup** — If the same fact ID appears in both SQLite and LanceDB results, only the first occurrence is kept. SQLite results are processed first, so SQLite wins when both backends return the same fact.

2. **Text-based dedup (case-insensitive)** — If two results have identical text (ignoring case), only the first occurrence is kept. Again, SQLite is processed first, so it wins ties.

3. **Superseded text filtering** — Before dedup, results whose text appears in `SupersededProvider.getSupersededTexts()` are discarded. This prevents old, replaced facts from surfacing even when they still match semantically. The `SupersededProvider` is an optional interface backed by `FactsDB`; if it is not provided, no superseded filtering is applied.

This means SQLite (BM25) results have priority in dedup, but both backends still contribute to the RRF score calculation. A fact that only appears in LanceDB results will have its LanceDB rank contribute to its RRF score normally.

### RRF k-parameter tuning

The `k` constant controls how sensitive RRF is to rank differences between results.

**What k controls:**
Each result's RRF contribution is `1 / (k + rank)`. The constant `k` sets a floor that dampens the advantage of top-ranked results. With `k=60`, the difference between rank 1 and rank 2 is small (`1/61` vs `1/62`). With `k=1`, rank 1 dominates (`1/2` vs `1/3`).

**Symptoms of k too high (e.g. k > 120):**
- All results score very similarly — ranking feels flat.
- Top keyword hits and top vector hits are not clearly distinguished from mid-list results.
- You see marginally relevant facts competing equally with highly relevant ones.

**Symptoms of k too low (e.g. k < 10):**
- Top-ranked results dominate aggressively.
- Long-tail results (ranked 5+) are effectively buried, even when they appear in both lists.
- Results that appear in only one backend but rank #1 there may score higher than results appearing in both backends but at rank 3.

**When to change k:**
For most users: **never**. The default `k=60` is well-established in the information retrieval literature and works well across a wide range of query types and corpus sizes. Consider tuning only if you have a large corpus (>10 000 facts) and have measured ranking quality systematically. The `k` parameter is exposed via the internal `MergeOptions` API; it is not surfaced in user config.

### Impact

Internal benchmarks showed a significant improvement in recall when moving from naive score merge to RRF. The benchmark compared raw recall@10 on a fixed test set of queries against known-relevant facts; exact methodology and corpus details are not published. Treat the improvement as qualitative — the ranking quality difference is clearly observable in practice.

> **Note:** The "+32% recall" figure previously cited here has been removed. We don't have sufficient details about the original benchmark methodology to cite it with confidence.

---

## Ingest workspace files

### Overview

`openclaw hybrid-mem ingest-files` indexes workspace markdown files (skills, TOOLS.md, AGENTS.md, etc.) as facts. An LLM extracts key capabilities and technical knowledge from each file; facts are stored with `category: technical`, `decayClass: stable`, and tag `ingest`.

### CLI

```bash
openclaw hybrid-mem ingest-files              # Use config or defaults
openclaw hybrid-mem ingest-files --dry-run    # Preview without storing
openclaw hybrid-mem ingest-files --workspace /path/to/project
openclaw hybrid-mem ingest-files --paths "skills/**/*.md,TOOLS.md,docs/api.md"
```

| Option | Default | Description |
|--------|---------|-------------|
| `--dry-run` | — | Show what would be processed without storing |
| `--workspace <path>` | `OPENCLAW_WORKSPACE` or cwd | Workspace root for glob resolution |
| `--paths <globs>` | Config or `skills/**/*.md,TOOLS.md,AGENTS.md` | Comma-separated glob patterns |

### Config

```json
{
  "ingest": {
    "paths": ["skills/**/*.md", "TOOLS.md", "AGENTS.md"],
    "chunkSize": 800,
    "overlap": 100
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `paths` | — | Glob patterns relative to workspace; required to enable ingest |
| `chunkSize` | 800 | Characters per chunk for LLM extraction |
| `overlap` | 100 | Overlap between chunks |

### Flow

1. Resolve workspace root (CLI `--workspace` or config/env).
2. Expand globs (e.g. `skills/**/*.md`) into file paths.
3. Read each file, chunk with overlap.
4. Send chunks to LLM with `ingest-files` prompt; parse JSONL facts.
5. Dedupe against existing memory (text + embedding similarity).
6. Store new facts with `source: "ingest"`, `decayClass: "stable"`, tags include `ingest`.

### When to run

- After adding or updating `skills/`, `TOOLS.md`, or other docs.
- Periodically (e.g. weekly) to refresh indexed content.
- Re-runs are safe: duplicates are skipped by existing dedup.

### Impact

Indexing a `skills/` folder can give ~+10% recall in benchmarks by making capability docs searchable during memory recall.

---

## HyDE (Hypothetical Document Embeddings)

### Overview

HyDE generates a short "hypothetical answer" to the user query before embedding. The embedding of that hypothetical text is used for vector search instead of the raw query. This can improve recall because hypothetical answers are closer in embedding space to actual stored facts.

### Config

```json
{
  "search": {
    "hydeEnabled": true,
    "hydeModel": "gpt-4o-mini"
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `hydeEnabled` | `false` | Enable HyDE for vector search |
| `hydeModel` | (unset) | Model for HyDE; when omitted, uses `llm.default` or legacy default (issue #92) |

### Where it applies

- `memory_recall` tool
- Auto-recall (injection at session start)

CLI `hybrid-mem search` does **not** use HyDE (no LLM available in that context).

### Trade-offs

- **Pros:** Can improve recall (~+5–8% in some benchmarks).
- **Cons:** Extra LLM call per search; adds latency and API cost.

HyDE is off by default. Enable when the recall gain justifies the extra cost.

---

## References

- Cormack, Clarke, Buettcher (2009): Reciprocal Rank Fusion
- r/openclaw: "How I built a memory system that actually works"
