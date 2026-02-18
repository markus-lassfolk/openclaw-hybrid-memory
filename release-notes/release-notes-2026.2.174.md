## 2026.2.174 (2026-02-17)

### Added

**`openclaw hybrid-mem distill`** — Native CLI for session distillation. Scans `~/.openclaw/agents/*/sessions/*.jsonl`, extracts text, sends to LLM for fact extraction, deduplicates by embedding similarity (0.85 threshold), stores net-new facts, runs `record-distill` automatically. Options: `--days` (default 3), `--all` (90 days), `--since`, `--dry-run`, `--model`, `--verbose`, `--max-sessions`. Cron-friendly: single exec, no complex agent prompts. See [issue #31](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/31).

**`openclaw hybrid-mem backfill`** — Index `MEMORY.md` and `memory/**/*.md` into SQLite + LanceDB. Options: `--dry-run`, `--workspace`, `--limit`.

### Fixed

- **[#27](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/27)** — Postinstall now rebuilds both `better-sqlite3` and `@lancedb/lancedb`; added `verify:publish` script.
- **[#28](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/28)** — `verify --fix` detects native bindings failures and runs `npm rebuild` automatically.
- **[#29](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/29)** — TROUBLESHOOTING documents config nesting when keys are at wrong level.
- **[#30](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/30)** — `hybrid-mem install` and `verify --fix` no longer add `agents.defaults.pruning` or top-level `jobs` (OpenClaw 2026.2.14 compat).

### Changed

- **Session distillation:** Cron example in OPERATIONS simplified to `openclaw hybrid-mem distill`.
- **Deploy snippet:** Removed top-level `jobs` array for OpenClaw config compatibility.
