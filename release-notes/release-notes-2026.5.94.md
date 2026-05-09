# Release notes — OpenClaw Hybrid Memory **2026.5.94**

**Context:** Prior **2026.5.x** operator notes include **[2026.5.61](release-notes-2026.5.61.md)** (maintenance visibility). **2026.5.94** (2026-05-09) adds **re-index safety**, **embedding-migration reliability**, and **tier-compact vs vectordb-optimize** clarity. See **[CHANGELOG.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)** for the full **`[2026.5.94]`** section.

## Who should install

Anyone running **`openclaw hybrid-mem re-index`**, large **embedding migrations**, or **LanceDB** maintenance who hit false-success / partial-vector-store incidents, or confusion between **tier compaction** and **LanceDB optimization**.

## What changed (high level)

- **Re-index**: build into a **shadow table**, validate, then **atomic swap** — partial failures no longer leave the live vector store empty ([#1246](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1246)).
- **Migration / CLI**: **`migrateEmbeddings`** reports **`aborted`** and reasons; **re-index** exits non-zero and skips swap on abort ([#1247](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1247)).
- **VectorDB**: **transparent reconnect** when `closeGeneration` advances mid-run, with a **Lance availability** check after reconnect; optional **`OPENCLAW_HYBRID_MEM_DEBUG_CLOSE=1`** close stack ([#1248](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1248)).
- **Commands / stats**: **`tier-compact`** (alias **`compact`**), **`vectordb-optimize`** called out in the maintenance overview, **`Last vectordb-optimize`** in **`stats`** ([#1249](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1249)).
- Plus audit / reflection / procedure and operator-doc improvements listed under **`[2026.5.94]`** in the changelog.

## Install

```bash
npm install -g openclaw-hybrid-memory@2026.5.94
```

Or add/update the plugin in your workspace / gateway config using the same version.

If you use **`openclaw-hybrid-memory-install`**, align it to **2026.5.94** so installer and plugin versions stay in sync.

## Changelog

See **[CHANGELOG.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)** — section **`[2026.5.94]`**.
