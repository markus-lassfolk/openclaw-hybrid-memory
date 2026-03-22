# Release notes — OpenClaw Hybrid Memory 2026.3.180

**Release date:** 2026-03-18

This release includes a **security dependency override** and documents **migration steps** for the retrieval pipeline API and Google embedding default. It is a maintenance and documentation release building on 2026.3.152.

---

## What’s in this release

### Security

- **Hono node server override (GHSA-wc8c-qw6v-h7f6)**  
  The plugin now pins `@hono/node-server` to a patched range (`>=1.19.10 <2`) via npm `overrides`. This addresses a known vulnerability without requiring manual dependency changes. No configuration or code changes are required on your side.

### For integrators and custom code

- **`runRetrievalPipeline` — new options-bag signature (#501)**  
  If you call `runRetrievalPipeline` from your own code (e.g. a fork or wrapper), you need to switch to the new signature:

  - **Before:** Many optional positional arguments after the five required ones.  
  - **After:** A single `options` object after the five required arguments (`query`, `queryVector`, `db`, `vectorDb`, `factsDb`). All optional settings (e.g. `config`, `budgetTokens`, `tagFilter`) go inside that object.

  Example:

  ```ts
  // Old (no longer supported)
  await runRetrievalPipeline(query, queryVector, db, vectorDb, factsDb, config, budgetTokens, tagFilter, ...);

  // New
  await runRetrievalPipeline(query, queryVector, db, vectorDb, factsDb, { config, budgetTokens, tagFilter, ... });
  ```

  If you only use the plugin via OpenClaw and the built-in tools/CLI, you don’t need to do anything.

- **Google embedding default: `text-embedding-004` → `text-embedding-005` (#385)**  
  If you use Google embeddings and had been on `text-embedding-004` (explicitly or as the previous default), the new default is `text-embedding-005`. Vectors from the two models are not compatible:

  - **Recommendation:** After upgrading, run `openclaw hybrid-mem re-index` to rebuild your LanceDB index with the new model so semantic search stays accurate.
  - **To stay on 004:** Set `embedding.model: "text-embedding-004"` in your plugin config.

---

## Upgrade

1. **Install or update** the plugin to 2026.3.180 (e.g. `openclaw plugins install openclaw-hybrid-memory` or your usual upgrade path).
2. **Security:** No action needed; the Hono override is applied automatically.
3. **Custom `runRetrievalPipeline` usage:** Migrate to the options-bag signature as shown above.
4. **Google embeddings:** Run `openclaw hybrid-mem re-index` after upgrading, or set `embedding.model: "text-embedding-004"` if you want to keep the previous model.

Full changelog: [CHANGELOG.md](../CHANGELOG.md#20263180---2026-03-18).
