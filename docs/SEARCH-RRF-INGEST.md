---
layout: default
title: Search improvements (RRF, ingest-files, HyDE)
parent: Features
nav_order: 14
---
# Search Improvements — RRF, ingest-files, HyDE

[Issue #33](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/33) adds three improvements to hybrid memory search:

1. **Reciprocal Rank Fusion (RRF)** — Better merging of SQLite FTS5 and LanceDB vector results
2. **`ingest-files`** — Index workspace markdown (skills, TOOLS.md, etc.) as searchable facts
3. **HyDE** — Hypothetical Document Embeddings for query expansion (opt-in)

---

## Reciprocal Rank Fusion (RRF)

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

### Optional: Custom k

The merge function accepts an optional `k` via internal API. Higher `k` reduces the penalty for lower ranks; lower `k` increases the boost for top-ranked results. Default 60 works well in practice.

### Impact

Benchmarks (e.g. r/openclaw) showed ~+32% recall when moving from naive score merge to RRF on a 50-query test set.

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

HyDE generates a short “hypothetical answer” to the user query before embedding. The embedding of that hypothetical text is used for vector search instead of the raw query. This can improve recall because hypothetical answers are closer in embedding space to actual stored facts.

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
| `hydeModel` | `gpt-4o-mini` | Model used to generate the hypothetical answer |

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
- r/openclaw: “How I built a memory system that actually works”
