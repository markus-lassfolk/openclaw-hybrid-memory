---
layout: default
title: Embedding Cache Contract
parent: Architecture & Internals
nav_order: 5
---
# The `fact_embeddings` cache contract

`fact_embeddings` is a SQLite table that caches canonical embedding vectors and their model
metadata alongside each fact. It is a **best-effort cache**, not the authoritative record of
which facts have a vector in LanceDB — that authority is LanceDB itself.

## Why this distinction matters

Before this contract was made explicit, storage diagnostics compared `fact_embeddings` row
counts directly against LanceDB row counts and treated any gap as "storage drift" or
corruption. In practice, `fact_embeddings` coverage legitimately lags LanceDB for several
reasons:

- **Structured (keyed) facts are never expected to have a vector.** Task-ledger entries and
  other `key`/`value` facts are addressable by key, not meant to be semantically searchable, and
  are excluded from both the vectorless-backlog repair path and the "expected to have a vector"
  population used by diagnostics (`backends/facts-db/stats.ts`'s
  `activeUnstructuredFactWhereClause`).
- **Shadow-table re-index doesn't write the cache during migration.** Writing `fact_embeddings`
  before a shadow table swap commits would let SQLite claim an embedding state the active Lance
  table doesn't actually have yet — the atomicity of the shadow-table approach requires deferring
  cache writes until after the swap succeeds. A re-index now runs a best-effort backfill pass
  (`services/vector-maintenance.ts`'s `backfillEmbeddingCacheFromVectorStore`) immediately after
  a successful swap, but that pass can partially fail or be skipped without failing the re-index.

## The contract

1. `fact_embeddings` coverage may legitimately be lower than LanceDB's canonical vector count.
   This is normal, not a health failure.
2. Storage-sync diagnostics (`services/storage-sync-diagnostics.ts`) treat ID-set alignment
   between SQLite's *expected-vector population* (active, unstructured facts) and LanceDB's
   unique IDs as the actionable "does this fact have a vector" signal — not `fact_embeddings`
   row counts.
3. `canonicalEmbeddings` (the `fact_embeddings` row count) is reported for operator visibility
   only, labeled as cache coverage. It never gates `verify`/`doctor` pass/fail status.
4. Repair/reembed/re-index paths that create or rebuild a canonical vector should still write
   `fact_embeddings` when they can (via `services/vector-maintenance.ts`'s
   `storeCanonicalVectorForFact`) so the cache converges toward LanceDB over time — it just isn't
   required to be perfectly in sync at every moment.

See also: [#2080](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/2080),
[#2084](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/2084).
