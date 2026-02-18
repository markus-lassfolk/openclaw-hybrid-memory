---
layout: default
title: CLI Reference
parent: Operations & Maintenance
nav_order: 1
---
# CLI Reference — memory-hybrid

All commands are available via `openclaw hybrid-mem <command>`.

---

## Commands

| Command | Purpose |
|---------|---------|
| `stats [--efficiency]` | Show fact count (SQLite) and vector count (LanceDB), version info, decay breakdown. `--efficiency` adds tier/source breakdown, token estimates, and token-savings note. |
| `compact` | **(FR-004)** Run tier compaction: completed tasks → COLD, inactive preferences → WARM, active blockers → HOT. Prints hot/warm/cold counts. |
| `store --text <text> [options]` | Store a fact (for scripts; agents use `memory_store`). |
| `lookup <entity> [--key <key>] [--tag <tag>] [--as-of <date>] [--include-superseded]` | Exact lookup in SQLite. **(FR-010)** `--as-of` = point-in-time (ISO or epoch); `--include-superseded` = include historical facts. |
| `search <query> [--tag <tag>] [--as-of <date>] [--include-superseded] [--user-id <id>] ...` | Semantic search over LanceDB + FTS5. **(FR-010)** `--as-of`, `--include-superseded` for bi-temporal queries. **(FR-006)** Scope filters. |
| `extract-daily [--dry-run] --days N` | Extract facts from daily logs (`memory/YYYY-MM-DD.md`). |
| `prune [--hard] [--soft] [--dry-run]` | Remove expired facts (decay/TTL). `--hard` only expired; `--soft` only confidence decay. |
| `checkpoint` | Create a checkpoint (pre-flight state). |
| `backfill-decay` | Backfill decay classes for existing rows. |
| `classify [--dry-run] [--limit N] [--model M]` | Auto-classify "other" facts using LLM. |
| `categories` | List all configured categories with per-category fact counts. |
| `find-duplicates [--threshold 0.92] [--include-structured] [--limit 300]` | Report pairs of facts with embedding similarity ≥ threshold. Report-only; no merge. |
| `consolidate [--threshold 0.92] [--include-structured] [--dry-run] [--limit 300] [--model M]` | Merge near-duplicate facts: cluster by embedding similarity, LLM-merge each cluster. |
| `reflect [--window <days>] [--dry-run] [--model M] [--force]` | Analyze recent facts, extract behavioral patterns. |
| `reflect-rules [--dry-run] [--model M] [--force]` | Synthesize patterns into actionable rules. |
| `reflect-meta [--dry-run] [--model M] [--force]` | Synthesize higher-level meta-patterns. |
| `install [--dry-run]` | Apply full recommended config, compaction prompts, and optional jobs. Idempotent. |
| `upgrade` | Upgrade to latest from npm. Removes current install, fetches latest, rebuilds native deps. Restart gateway afterward. |
| `verify [--fix] [--log-file <path>]` | Verify config, DBs, embedding API; suggest fixes. |
| `distill [--all] [--days N] [--since YYYY-MM-DD] [--dry-run] [--model M] [--verbose] [--max-sessions N] [--max-session-tokens N]` | Index session JSONL into memory (LLM extraction, dedup, store). Default: last 3 days. `--model M` picks the LLM (e.g. `gemini-2.0-flash` for Gemini; config `distill.defaultModel` used when omitted). Gemini uses larger batches (500k tokens). Oversized sessions chunked with 10% overlap. |
| `distill-window [--json]` | Print the session distillation window (full or incremental). |
| `record-distill` | Record that session distillation was run (timestamp for `verify`). |
| `extract-procedures [--dir path] [--days N] [--dry-run]` | Extract tool-call procedures from session JSONL; store positive/negative procedures. |
| `generate-auto-skills [--dry-run]` | Generate `skills/auto/{slug}/SKILL.md` and `recipe.json` for procedures that reached validation threshold. |
| `credentials migrate-to-vault` | Move credential facts from memory into vault and redact originals. |
| `scope prune-session <session-id>` | **(FR-006)** Delete session-scoped memories for a given session (cleared on session end). |
| `scope promote --id <fact-id> --scope global or agent [--scope-target <target>]` | **(FR-006)** Promote a session-scoped memory to global or agent scope (persists after session end). |
| `uninstall [--clean-all] [--force-cleanup] [--leave-config]` | Revert to default OpenClaw memory (memory-core). |

---

## Store options

```
openclaw hybrid-mem store --text <text> [--category <cat>] [--entity <e>] [--key <k>] [--value <v>] [--source-date YYYY-MM-DD] [--tags "a,b,c"] [--scope global|user|agent|session] [--scope-target <id>] [--supersedes <fact-id>]
```

- `--source-date`: When the fact originated (ISO-8601). Include when parsing old memories.
- `--tags`: Comma-separated topic tags. Omit for auto-tagging.
- `--category`: Override category (default: `other`).
- `--scope` **(FR-006):** Memory scope: `global` (default), `user`, `agent`, or `session`. See [MEMORY-SCOPING.md](MEMORY-SCOPING.md).
- `--scope-target`: Required when scope is `user`, `agent`, or `session` — the userId, agentId, or sessionId.
- `--supersedes`: Fact id this one supersedes (replaces).
- **(FR-008)** When `store.classifyBeforeWrite` is true in config, `store` runs ADD/UPDATE/DELETE/NOOP classification against similar facts before writing.

---

## Stats and efficiency

`openclaw hybrid-mem stats` shows fact counts, LanceDB vectors, and decay breakdown.

Add `--efficiency` for an extended view:

```
openclaw hybrid-mem stats --efficiency
```

This adds:
- **By tier (hot/warm/cold):** Fact counts and estimated tokens per tier
- **By source:** How facts were added (conversation, cli, distillation, reflection, auto-capture, etc.)
- **Estimated tokens in memory:** Total token size of stored facts (same heuristic as auto-recall)
- **Token savings note:** Explains that providers can cache injected memories; Cache Read is typically 90%+ cheaper than Input. Compare your provider dashboard (Input vs Cache Read) to see actual savings — many users see 90–97% reduction.

---

## Verify and doctor

`openclaw hybrid-mem verify` checks:

- Config (embedding API key and model)
- SQLite and LanceDB accessibility
- Embedding API reachability
- Credentials vault (if enabled)
- Session distillation last run
- Optional/suggested jobs (nightly-memory-sweep, weekly-reflection)
- Feature flags (autoCapture, autoRecall, autoClassify, credentials, fuzzyDedupe, classifyBeforeWrite)

Issues are listed as **load-blocking** (prevent OpenClaw from loading) or **other**, with **fixes for each**.

`--fix` applies safe fixes: missing embedding block, nightly and weekly-reflection jobs, memory directory.
`--log-file <path>` scans the file for memory-hybrid or cron errors.

---

## Uninstall

`openclaw hybrid-mem uninstall` reverts to the default OpenClaw memory manager (memory-core). Safe: your data is kept unless you pass `--clean-all` (removes SQLite and LanceDB; irreversible). Use `--leave-config` to skip modifying `openclaw.json`. Full guide: [UNINSTALL.md](UNINSTALL.md).

---

## Tips

- Run `classify --dry-run` first to preview, then run without `--dry-run` to apply.
- Run `find-duplicates` to review candidates, then `consolidate --dry-run` before applying.
- Run `verify` as a health check after installation or upgrades.
- Use `install --dry-run` to preview config changes before applying.

---

## Related docs

- [QUICKSTART.md](QUICKSTART.md) — Installation and first run
- [CONFIGURATION.md](CONFIGURATION.md) — Full config reference
- [FEATURES.md](FEATURES.md) — Categories, decay, tags, auto-classify
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — Common issues and fixes
- [REFLECTION.md](REFLECTION.md) — Reflection layer (`reflect`, `reflect-rules`, `reflect-meta`)
- [CREDENTIALS.md](CREDENTIALS.md) — Credentials vault (`credentials migrate-to-vault`)
- [SESSION-DISTILLATION.md](SESSION-DISTILLATION.md) — Session distillation (`distill-window`, `record-distill`)
- [PROCEDURAL-MEMORY.md](PROCEDURAL-MEMORY.md) — Procedural memory (`extract-procedures`, `generate-auto-skills`)
- [MEMORY-SCOPING.md](MEMORY-SCOPING.md) — **(FR-006)** Scope types, store/recall filters, session cleanup, promote
