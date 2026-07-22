# AGENTS.md

Repository-wide guidance for coding agents. For architecture, commands, style, and Git/PR
conventions, follow `CLAUDE.md` (the authoritative developer guide). This file only adds
cloud-environment-specific caveats that are not obvious from `CLAUDE.md`.

## Cursor Cloud specific instructions

Dependencies are already installed on session start by the update script (`npm install` at the
repo root and in `extensions/memory-hybrid`, `extensions/memory-hybrid/graph-app`, and
`sdk/openclaw-memory-js`). Do not re-run installs unless `package.json`/lockfiles changed.

### Node version (important, non-obvious)

- The repo requires Node `>=22.16.0` (uses built-in `node:sqlite`). See `CLAUDE.md`.
- On this VM, `node` on `PATH` resolves to `/exec-daemon/node`, which is **v22.14.0 (below the
  requirement)**. `nvm` provides a supported Node (default `v22.22.2`, and `v22.16.0` matching
  `.nvmrc`).
- All `npm run *` scripts re-exec through `scripts/run-with-supported-node.mjs`, which auto-selects
  a supported Node (it resolves the `.nvmrc`-pinned `$NVM_DIR/versions/node/v22.16.0/bin/node`, or
  scans `PATH`). So `npm run build|test|lint`, `npx tsc --noEmit`, etc. work regardless of the
  `PATH` `node`.
- For **direct** `node`/`npx` invocations (not via an npm script), first run `nvm use` (or prepend
  `$HOME/.nvm/versions/node/v22.16.0/bin` to `PATH`); otherwise you get 22.14.0.

### Tests

- `npm test` (from `extensions/memory-hybrid`) runs the full suite (~780 files, ~7 min).
- A few optimistic-concurrency tests are **flaky**, primarily in `tests/active-task.test.ts`
  (occasionally `tests/active-task-reconcile-race.test.ts`,
  `tests/stage-cleanup-markdown-ledger.test.ts`). They simulate a concurrent writer using
  file-`mtime`-based optimistic-write detection; under CPU/disk contention the mtimes can collide,
  so the failing set varies run-to-run. This is pre-existing test flakiness, not a code/env defect
  — re-run the specific file(s) to confirm before investigating.

### Running the product locally (no OpenClaw host required for a smoke test)

The product is an OpenClaw plugin that normally loads inside the OpenClaw gateway. To exercise the
core memory engine + Mission Control UI locally without a gateway or external embeddings:

- Build first: `npm run build` (and `npm run build:graph-app` so `/graph` serves in prod mode).
- `FactsDB` and `VectorDB` are exported via `_testing` from the built `dist/index.js`; construct
  them with a temp path, `factsDb.store({ text, category, source, ... })` to write and
  `factsDb.search(query, limit)` to recall (SQLite FTS5, no embeddings needed).
- `createDashboardServer(ctx, 7700)` (from `dist/routes/dashboard-server.js`) starts Mission
  Control on `127.0.0.1:7700`; the memory viewer (`/api/viewer/*`), the Memory Graph SPA (`/graph`),
  and `/api/graph` read directly from SQLite.
- **Embeddings/LLM are required only for vector/semantic recall and LLM features** (auto-capture
  enrichment, distillation, crystallization) — configure a provider per `docs/LLM-AND-PROVIDERS.md`
  (`OPENAI_API_KEY`, `GOOGLE_API_KEY`, local Ollama, or ONNX). Structured facts + dashboard work
  without them.
- The dashboard **Workshop** panel requires full plugin config (`hybridCfg` with workshop enabled);
  a bare harness returns `"workshop context is not configured"` — expected, not a bug.
