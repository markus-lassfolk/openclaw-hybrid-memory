# Follow-up: per-source vector cosine dedupe at write time (#1194-vector)

`storeFact` / `applyDedupe` run synchronously on the SQLite path, while embeddings are produced asynchronously. When a dedupe profile sets `vectorThreshold`, the runtime emits a warning and skips cosine matching until this gap is closed.

**Proposed work**

1. Plumb a best-effort pre-store embedding (or a post-embed merge pass) so `applyDedupe` can compare against `ctx.embedding`.
2. Integration test with known near-duplicate vectors once the pipeline is wired.

File a dedicated GitHub issue referencing this note and close the PR item once the warning path is replaced by real behavior.
