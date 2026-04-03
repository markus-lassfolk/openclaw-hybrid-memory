---
name: openclaw_hybrid_memory
description: OpenClaw hybrid memory (memory-hybrid plugin)—SQLite+FTS5 facts, LanceDB semantic recall, auto-capture/recall, decay, contacts/org layer (memory_directory), multilingual NER when graph is on, memorySearch, and memory/ files. Use whenever the user asks about saving or recalling information, memory_store or memory_recall, people or companies in memory, hybrid-mem CLI, MEMORY.md, pruning, distillation, embeddings, tuning recall, which memory settings are enabled, how to optimize or run maintenance (run-all, verify, config, enrich-entities, digest pipelines, cron order), or debugging missing recall—even if they do not say "hybrid memory" by name.
---

# OpenClaw Hybrid Memory

You have **two database-backed layers** plus **file-backed** memory; they are designed to work together.

| Layer | Role | Agent action |
| --- | --- | --- |
| **Structured facts** | Fast exact-ish lookup (FTS5), entities, categories | Often automatic; use tools when the user asks to save or look up something durable |
| **Vector recall** | Fuzzy "what was that thing?" semantic matches | Often automatic; use `memory_recall` when you need to search explicitly |
| **Contacts & orgs** | Structured people/orgs derived from facts (NER + SQLite) | Use `memory_directory` (`list_contacts`, `org_view`) for lists tied to an org or name prefix—not a substitute for `memory_recall` ranking |
| **Files** | Long-form truth, project state, narrative | Read/write `memory/**/*.md`; keep **MEMORY.md** lean (index), details in subfiles |
| **memorySearch** | Search over markdown files the agent wrote | Usually automatic; do not confuse with LanceDB recall |

**Token discipline:** Bootstrap files load every turn—keep **MEMORY.md** short. Put bulk reference in `memory/**` and pull it in with search or explicit reads.

## Tool names (critical)

All memory-hybrid tools use **underscore** names: `memory_store`, `memory_recall`, `memory_directory`, `memory_forget`, etc. **Do not** use dotted aliases (`memory.store`); some providers reject them.

## When to call tools explicitly

- **Save something that must survive a new session or compaction:** use `memory_store` (and update `memory/` if the user wants a human-readable log).
- **Search or verify what is stored:** use `memory_recall` with a clear query; narrow with category/tags if the config supports it.
- **List people, or everything tied to a company/org:** use `memory_directory` (`list_contacts` or `org_view` with `org_name`) for **structured** results; use `memory_recall` when you need semantic search ranking.
- **User asks to forget or correct a bad fact:** use the appropriate forget/update flow (e.g. `memory_forget` or supersede via store) per plugin behavior.

If **auto-capture** and **auto-recall** are on, many turns need no tool call—but still **store** when the user explicitly asks to remember, or when the information is important and might not be captured automatically.

## CLI and health checks

- **`openclaw hybrid-mem verify [--fix]`** — Confirms SQLite, LanceDB, embedding config, and related jobs. Use when memory seems broken after config or gateway changes.
- **`openclaw hybrid-mem stats`** — Quick view of store state.
- **`openclaw hybrid-mem enrich-entities`** — Backfill PERSON/ORG extraction for facts missing mention rows (after upgrades or bulk imports; uses LLM when graph features are on).
- Prefer plugin docs for full command lists (prune, distill, ingest-files, etc.).

## Configuration mindset

- **Embedding provider** must be valid or the plugin fails to load—fix provider, model, and dimensions before debugging "no memories."
- **Scopes** (global / user / agent / session) matter for who sees a fact; match the user's intent.
- **Decay / tiering** affect how long items stay hot—do not assume everything is permanent unless configured.

## Progressive disclosure

- For deep behavior (HyDE, RRF, procedures, crystallization, cron jobs), rely on **this skill for basics**, then read project docs or the plugin README when a task requires a specific subsystem.

## Optimizing memory (inspection, settings, task order)

When the user wants **maximum memory quality**, **which toggles are on**, **what to enable next**, or a **step-by-step maintenance / digest / optimization run**:

1. Tell them to run **`openclaw hybrid-mem verify`** and **`openclaw hybrid-mem config`** first (ground truth for health + flags).
2. For a **single bundled catch-up**, use **`openclaw hybrid-mem run-all`** (respects feature flags; see repo docs for what it includes vs cron-only tasks).
3. For **manual ordering** (nightly → weekly → monthly mirrors) and **high-impact settings**, read the bundled reference:

**`references/memory-optimization.md`** (same folder as this `SKILL.md` in the workspace after install)

That file covers: inspection commands, benefit-ranked settings, `run-all` vs one-by-one chains, and how cron maps to CLI—without duplicating the full repo manuals.

## Reference

- **Optimization guide (bundled):** `references/memory-optimization.md`
- Upstream docs: [openclaw-hybrid-memory repository](https://github.com/markus-lassfolk/openclaw-hybrid-memory) (`docs/QUICKSTART.md`, `docs/CONFIGURATION.md`, `docs/GRAPH-MEMORY.md`, `docs/MULTILINGUAL-SUPPORT.md`, `docs/MAINTENANCE-TASKS-MATRIX.md`).
- OpenClaw skills layout: [Creating skills](https://docs.openclaw.ai/tools/creating-skills).
