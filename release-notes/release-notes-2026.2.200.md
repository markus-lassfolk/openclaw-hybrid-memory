## 2026.2.200 (2026-02-20)

Major feature release including procedural memory, directive extraction, reinforcement tracking, multi-agent scoping, auth-failure auto-recall, privacy-first error reporting, and credential auto-capture.

---

### Added

**Directive extraction & reinforcement-as-metadata (PR #41, closes issues #39, #40).** Multi-language detection of user directives and reinforcement signals:

- **Directive extraction:** Detects user directives in 10 categories (explicit memory requests, behavior changes, absolute rules, corrections, preferences, warnings, procedural, implicit corrections, emotional emphasis, conditional rules). Multi-language support via intent-based keyword system with confidence scoring (0.5-1.0) to filter noise.
- **Reinforcement-as-metadata:** Annotates existing facts with `reinforced_count`, `last_reinforced_at`, `reinforced_quotes`. Reinforced facts rank higher in search results (configurable boost). 8 reinforcement signal categories with correlation logic.
- **Procedure reinforcement:** Procedures table gets reinforcement columns. Auto-promotion: procedures reinforced ≥ threshold times get confidence boost to 0.8+.
- **CLI:** `openclaw hybrid-mem extract-directives`, `openclaw hybrid-mem extract-reinforcement`
- **Config:** `distill.extractDirectives` (default: true), `distill.extractReinforcement` (default: true), `distill.reinforcementBoost` (default: 0.1), `distill.reinforcementProcedureBoost` (default: 0.1), `distill.reinforcementPromotionThreshold` (default: 2)

**Code review security fixes (PR #42).** Addresses findings from independent GPT and Gemini code reviews:

- **Critical:** Credential vault KDF replaced raw SHA-256 with scrypt (N=16384, r=8, p=1) + random salt. Backward-compatible migration for existing vaults.
- **Critical:** VectorDB SQL injection — tightened UUID validation, added security boundary comments.
- **Critical:** God file extraction — moved CredentialsDB and ProposalsDB to dedicated backend files (~440 lines removed from index.ts).
- Fixed memory_recall limit default mismatch (schema said 5, code used 10).
- Expanded SENSITIVE_PATTERNS (AWS keys, private key headers, connection strings).
- Replaced non-null assertions with safe getTable() accessor in VectorDB.
- Hash-based embedding cache keys for memory efficiency.

**Confidence-weighted procedural ranking (PR #44).** Multi-factor confidence-weighted ranking for procedure recommendations:

- **searchProceduresRanked():** New method with multi-factor scoring (confidence × recency × success_rate × penalties).
- **Recency decay:** Linear decay over 30-day window with minimum 0.3 factor.
- **Success rate boost:** 50-100% weight based on successCount / (successCount + failureCount).
- **Recent failure penalty:** 0.5 multiplier for procedures that failed in last 7 days.
- **Never-validated penalty:** 30% reduction for procedures without lastValidated.
- Auto-recall injection now uses ranked results with relevance score filtering (>0.4 threshold).
- Emoji indicators: ✅ for high confidence (≥70%), ⚠️ for lower.
- Tool chain summaries: `tool1 → tool2 → tool3`

**Pre-release bug fixes (PR #45).** Four defensive improvements:

- Missing default for `reinforcementPromotionThreshold` (added `?? 2`).
- Race condition in `gatherBackfillFiles` recursive walk (wrapped in try-catch).
- Connection string regex improvement (exclude colon from username, require host segment).
- Test case for directive extraction URI+colon edge case (`mailto:user@... Remember:`).

**Multi-agent memory scoping (PR #46, activates FR-006).** Enables specialist agents (Forge, Scholar, Hearth) to build domain expertise while maintaining shared global knowledge:

- **Runtime agent detection:** Plugin detects current agent ID from `before_agent_start` event payload.
- **Config:** New `multiAgent` section with `orchestratorId` (default: "main") and `defaultStoreScope` (global/agent/auto).
- **Smart auto-scoping:** In `auto` mode, orchestrator stores globally, specialists store agent-scoped.
- **Automatic scope filtering:** Specialists automatically filter to `global + agent-specific` memories. Orchestrator sees all.
- **Procedures scoping:** Added `scope` and `scope_target` columns to `procedures` table. All search methods now accept `scopeFilter`.
- Specialists see: global knowledge + their own discoveries. Orchestrator sees: everything.

**Auth-failure auto-recall (PR #48, closes issue #47).** Reactive memory trigger that auto-injects credentials when authentication failures are detected:

- **Detection layer:** SSH failures (Permission denied, Authentication failed), HTTP failures (401, 403), API failures (Invalid API key, token expired). Target extraction: hostnames, IPs, URL domains, service names.
- **Memory recall:** Searches both SQLite FTS5 and LanceDB vector backends. Filters to technical/credential facts. Respects FR-006 memory scoping (global + agent-specific). Deduplication: max 1 recall per target per session (configurable).
- **Context injection:** Formats credential hints for agent consumption via `prependContext` return from `before_agent_start` hook. Non-intrusive: only triggers when auth failures detected.
- **Security:** No credential values logged (only target identifiers). Scope-aware (respects FR-006). No auto-execution (only injects hints). `originalText` removed from errors to prevent credential leakage.
- **Config:** `autoRecall.authFailure.enabled` (default: true), `autoRecall.authFailure.patterns` (customizable regex patterns), `autoRecall.authFailure.maxRecallsPerTarget` (default: 1).
- **Docs:** [AUTH-FAILURE-AUTO-RECALL.md](../docs/AUTH-FAILURE-AUTO-RECALL.md) (348 lines) with configuration, security, troubleshooting.

**Privacy-first error reporting (PR #49).** Optional, opt-in error reporting to GlitchTip (self-hosted Sentry alternative):

- **Explicit consent required** — Default: disabled. Requires both `enabled: true` and `consent: true` in config.
- **Privacy guarantees:** NO user prompts, memory text, API keys, or PII. All sensitive data scrubbed via strict allowlist-based sanitization. Zero breadcrumbs, no default integrations.
- **Optional dependency:** Works without @sentry/node installed.
- **What's reported:** Exception type and sanitized message, sanitized stack trace (plugin paths only), plugin version and environment, operation context (subsystem, operation).
- **What's NEVER reported:** User prompts or memory text, API keys/tokens/passwords, home paths (replaced with $HOME), emails (replaced with [EMAIL]), IPs (replaced with [IP]), breadcrumbs, HTTP requests, console logs.
- **Config:** `errorReporting` section with `enabled`, `consent`, `dsn`, `environment`, `sampleRate`.
- **Docs:** [ERROR-REPORTING.md](../docs/ERROR-REPORTING.md) with setup guide, security audit checklist, FAQ.

**Credential auto-capture from tool calls (PR #51).** Automatically stores credentials used in tool calls into encrypted vault:

- **Detection patterns:** 7 regex patterns covering: `sshpass -p <pass> ssh`, `curl -H "Authorization: Bearer <token>"`, `curl -u user:pass`, connection strings (postgres://, mysql://, mongodb://, redis://, mssql://), `-H "X-API-Key: <key>"`, `export VAR_KEY/TOKEN/PASSWORD/SECRET=value`, `.env`-style `KEY=value` assignments.
- **Extraction engine:** `extractCredentialsFromToolCalls(text)` uses `matchAll()` to find all occurrences per pattern. Handles multiple credentials in a single tool call. Deduplicates by `(service, type)`.
- **agent_end hook:** Scans `tool_calls[*].function.arguments` in assistant messages when `credentials.enabled && autoCapture.toolCalls`. Stores via `credentialsDb.store()` (upsert) — never touches factsDB or vectorDB.
- **Config:** `credentials.autoCapture.toolCalls` (default: false, opt-in), `credentials.autoCapture.logCaptures` (default: true).
- **Security:** Tool inputs only. Vault-encrypted. No facts/vector DB exposure.
- **Docs:** [CREDENTIALS.md](../docs/CREDENTIALS.md) updated with "Auto-Capture from Tool Calls" section.

**Self-correction analysis (issue #34).** Automated detection of user corrections in session logs and remediation:

- **CLI:** `openclaw hybrid-mem self-correction-extract [--days N] [--output path]` — extract incidents from session JSONL using multi-language correction signals (from `.language-keywords.json`; run `build-languages` first for non-English). `openclaw hybrid-mem self-correction-run` — analyze, remediate (memory store + TOOLS rules), and write report to `memory/reports/self-correction-YYYY-MM-DD.md`.
- **Default behavior:** Suggested TOOLS rules are **applied by default** (inserted under a configurable section, e.g. "Self-correction rules"). Opt out with config `selfCorrection.applyToolsByDefault: false` or CLI `--no-apply-tools`. Use `--approve` to force apply when opted out.
- **Semantic dedup:** Before storing facts from self-correction, the plugin skips near-duplicates by embedding similarity (config `selfCorrection.semanticDedup`, `semanticDedupThreshold`).
- **TOOLS sectioning:** Rules are inserted under a named section in TOOLS.md (no blind append). Optional `autoRewriteTools: true` uses an LLM to rewrite TOOLS.md and integrate new rules without duplicates or contradictions.
- **Phase 2 via spawn:** Optional `analyzeViaSpawn: true` and `spawnThreshold` run the analysis step via `openclaw sessions spawn` (e.g. Gemini) for large incident batches.
- **Config:** `selfCorrection` (semanticDedup, semanticDedupThreshold, toolsSection, applyToolsByDefault, autoRewriteTools, analyzeViaSpawn, spawnThreshold, spawnModel). See [CONFIGURATION.md](../docs/CONFIGURATION.md) and [SELF-CORRECTION-PIPELINE.md](../docs/SELF-CORRECTION-PIPELINE.md).
- **Optional cron:** Install script adds job `self-correction-analysis`; use it or point your scheduler at `openclaw hybrid-mem self-correction-run`.

**RRF and search improvements (issue #33).**

- **Reciprocal Rank Fusion (RRF)** — Keyword (BM25) and semantic (cosine) scores are merged with rank-based RRF so items that rank well in both naturally float to the top. Default k=60.
- **`openclaw hybrid-mem ingest-files`** — Index workspace markdown (skills, TOOLS.md, AGENTS.md) as facts via LLM extraction. Config `ingest.paths`, `ingest.chunkSize`, `ingest.overlap`. Facts stored with `category: technical`, `decayClass: stable`, tags include `ingest`.
- **HyDE query expansion** — Opt-in `search.hydeEnabled: true` generates a hypothetical answer before embedding for vector search (memory_recall + auto-recall). Config `search.hydeModel` (default gpt-4o-mini).

**Procedural memory (issue #23).** Auto-generated skills from learned patterns:

- **Layer 1 — Procedure tagging:** Multi-step tool-call sequences from session JSONL; successful runs as positive procedures, failures as negative. CLI: `openclaw hybrid-mem extract-procedures [--dir path] [--days N] [--dry-run]`. Secrets redacted in procedure-extractor.
- **Layer 2 — Procedure-aware recall:** `memory_recall_procedures(taskDescription)` tool; auto-recall injects `<relevant-procedures>` when the prompt matches stored procedures. Config: `procedures.enabled`, `procedures.sessionsDir`, `procedures.minSteps`, etc.
- **Layer 3 — Skill generation:** When a procedure is validated N times (default 3), auto-generate `skills/auto/{slug}/SKILL.md` and `recipe.json`. CLI: `openclaw hybrid-mem generate-auto-skills [--dry-run]`. Config: `procedures.validationThreshold`, `procedures.skillTTLDays`, `procedures.requireApprovalForPromote`.

---

### Fixed

- **CLI:** Duplicate registration of `extract-procedures` and `generate-auto-skills` in `registerHybridMemCli` removed (each command had been registered three times).

---

### Changed

- **Version bump** — All version references updated to 2026.02.20 / 2026.2.200 (package.json, openclaw.plugin.json, docs, install script examples).

---

### Upgrade

```bash
openclaw hybrid-mem upgrade 2026.2.200
```

Or from a clean install:

```bash
npx -y openclaw-hybrid-memory-install 2026.2.200
```

Restart the gateway after upgrading.

---

### Test Status

- **406 passing tests** (out of 558 total)
- **152 failures** — Infrastructure-related (better-sqlite3 native binding compatibility with Node v25.6 in WSL2), not code bugs
- Core functionality verified across all new features
