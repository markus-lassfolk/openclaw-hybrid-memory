# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

OpenClaw Hybrid Memory — persistent, local-first memory for OpenClaw agents. The published npm package (`openclaw-hybrid-memory`) lives in **`extensions/memory-hybrid/`**, and nearly all development happens there. Storage is hybrid: **SQLite** (built-in `node:sqlite`, FTS5) for structured facts plus **LanceDB** for vector/semantic recall.

Other top-level pieces:
- `extensions/memory-hybrid/graph-app/` — React/Vite SPA (interactive Memory Graph served at `/graph`); its own package, built into `graph-app/dist/`
- `packages/openclaw-hybrid-memory-install/` — standalone installer package
- `sdk/openclaw-memory-js/` — `@openclaw/memory-client` TypeScript SDK (tsup build)
- `docs/` — 250+ markdown docs, published as a GitHub Pages site
- `scripts/` — repo-level operational scripts (deploy, upgrade, node-version wrapper)

## Node version (critical)

**Node ≥ 22.16.0 is required** — the plugin uses `node:sqlite`, which does not exist on Node 20. All npm scripts re-exec through `scripts/run-with-supported-node.mjs` to defend against IDE-bundled Node 20 (e.g. Cursor on WSL). CI runs Node 22.16 and 24.

## Commands

All run from `extensions/memory-hybrid/`:

```bash
npm install                        # install deps
npm run build                      # tsdown → dist/
npx tsc --noEmit                   # typecheck (CI-required)
npm run lint                       # biome lint
npm run lint:fix                   # biome auto-fix (uses --unsafe)
npm run format                     # biome format --write
npm test                           # vitest run (full suite, 700+ test files)
npm test -- tests/foo.test.ts      # run a single test file
npm run test:watch                 # vitest watch mode
npm run test:coverage
npm run verify:gate                # typecheck:gate + maintenance-gate + schema-gate tests (CI-required)
npm run lint:arch                  # architectural lint (scripts/lint-arch.sh, warn-only)
```

Graph app (separate package): `cd graph-app && npm install && npm test && npm run build`.

Before opening a PR, the required trio from the PR template checklist is: `npx tsc --noEmit`, `npm run lint`, `npm test`.

## Architecture (extensions/memory-hybrid/)

Entry: `index.ts` defines the plugin object; `setup/register-plugin.ts` wires stores, agent tools, CLI, lifecycle hooks, and HTTP routes. Config schema lives in `openclaw.plugin.json` + `config/hybrid-schema.ts`; defaults and parsing in `config.ts` + `config/`.

Layers (dependencies point roughly top → bottom):
- `lifecycle/` — hook pipeline stages (`stage-recall`, `stage-capture`, `stage-injection`, …) that run on agent lifecycle events; auto-capture/auto-recall lives here
- `tools/` — agent-facing tools (`memory_store`, `memory_recall`, …) plus HTTP route registration (dashboard routes, public API routes)
- `cli/` — `openclaw hybrid-mem …` commands (commander). New subcommands go in `cli/commands/manage/register-*.ts`, not a monolithic `manage.ts`
- `services/` — business logic (~320 modules: ranking/RRF, consolidation, distillation, decay, crystallization, maintenance orchestration, …)
- `backends/` — storage. `facts-db/` is decomposed (crud, links, procedures, episodes, entity layer, …); `vector-db/` wraps LanceDB; `event-bus.ts`; `migrations/`
- `routes/` — Mission Control dashboard server (local-only, `127.0.0.1:7700`, registered separately from the OpenClaw gateway) plus GraphQL/SSE backing the graph app
- `setup/` — bootstrap, DB init, embedding/LLM provider routing, tool/hook registration

Key patterns:
- SQLite uses the **synchronous** `node:sqlite` API (`DatabaseSync`) — no async/await on DB calls. Always use parameterized statements; SQL string interpolation is a blocking review issue.
- All stores extend `backends/base-sqlite-store.ts` (WAL pragmas, reconnection after SIGUSR1/SIGUSR2, deferred close) and implement `close()`; after close they throw `"<StoreName> is closed"`. DB operations must handle errors explicitly — background timers must never crash the gateway process.
- Vector search results are re-ranked in the service layer; result-set sizes are bounded via `OPENCLAW_HYBRID_MEM_*` env vars.
- Event Bus (`backends/event-bus.ts`): append-only `memory_events` table decoupling sensor producers from distributed consumers (maintenance / Dream paths); status lifecycle `raw → processed → surfaced → pushed → archived`. There is no separate Rumination Engine process (#2178).
- Agent tool names use **underscores** (`memory_store`), never dots. The canonical list is `contracts/agent-tool-names.ts`; parity is enforced by `npm run test:schema-gate`.
- Schema migrations (`backends/migrations/`) run at plugin init. Bump `schemaVersion` in `versionInfo.ts` for breaking schema changes.
- Embeddings are required at runtime (OpenAI, Ollama, ONNX, or Google); LLM features use tiered chat models (`llm.nano` / `llm.default` / `llm.heavy`) with ordered fallback. See `docs/LLM-AND-PROVIDERS.md`.

## Testing

- Vitest with `globals: true`, 15s test timeout; tests live in `tests/*.test.ts`.
- The OpenClaw plugin SDK is mocked via vitest aliases to `tests/__mocks__/openclaw-plugin-sdk*.ts` (see `vitest.config.ts`) — the suite runs without a real OpenClaw install.
- Graph-app browser e2e is opt-in: `RUN_GRAPH_E2E=1 npm test -- tests/graph-app-e2e.smoke.test.ts` (needs Chrome; set `GRAPH_E2E_CHROMIUM` to its path).

## Style

Biome enforces: 120-column width, 2-space indent, double quotes, semicolons, trailing commas, `node:` import protocol. `console.*` is a lint **error** in production code — use `utils/logger.ts` (`cli/`, `tests/`, `benchmark/` are exempt). Floating promises are errors. TypeScript is strict; the package is ESM (`"type": "module"`) with `.js` suffixes on relative imports. Avoid `any` where it can be narrowed.

Husky + lint-staged auto-format staged `extensions/memory-hybrid/**/*.ts` on commit (run `npm install` at the repo root once to enable hooks).

## Git/PR conventions

- PR titles must follow Conventional Commits (`fix:`, `feat:`, `docs:`, …) — CI validates the title. Revert PRs use lowercase `revert: <what>`.
- Squash-merge to main. When updating a branch, rebase onto main rather than merging main in.
- CI classifies changed paths (`.github/scripts/classify-changes.mjs`): docs-only PRs skip code CI via passthrough jobs; source changes run the full matrix (typecheck/lint/test on Node 22 + 24, maintenance gate, coverage, graph-app smoke, install smoke, publish invariants).
- Releases use CalVer-style versions (`2026.M.PATCH`) in `extensions/memory-hybrid/package.json`. After CI passes on main, `tag-release-after-ci.yml` pushes the `v<version>` tag and the Release workflow publishes the GitHub Release + npm package. Release notes go in `release-notes/release-notes-<version>.md` with a matching `CHANGELOG.md` section.
- Update `docs/` for any user-facing behavior change (the PR template has a required documentation-impact section).
