# Release Notes — OpenClaw Hybrid Memory 2026.3.250

**Release date:** 2026-03-24  
**Previous release:** [2026.3.181](release-notes-2026.3.181.md) (2026-03-18)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md#20263250---2026-03-24)

---

## Overview

This is the largest feature release since memory-manager 3.0. Over 40 commits spanning six days introduce **production-grade RAG**, **temporal memory narratives**, **identity reflection**, an **auto-generated mind-map**, a **task-queue watchdog**, and a comprehensive **database reliability overhaul**. Five crash-level bugs caught through live telemetry are fixed.

If you were seeing `EventLog is closed`, `database is not open`, or `All embedding providers failed` errors in your gateway logs — this release fixes all of them.

---

## What's New

### 🧠 Richer Memory: Narratives, Identity & Mind-Map

**Session Narratives (NarrativesDB)**  
At the end of every agent session the plugin now synthesizes a narrative summary from the event log and stores it in a new `NarrativesDB`. On the next session the agent gets a brief "what happened last time" context block — making it feel genuinely continuous across conversations rather than stateless.

**Identity Reflection**  
A dedicated reflection pass analyses the agent's own outputs to build a durable persona identity store. The agent now maintains self-awareness of its own patterns, preferences, and working style across sessions. Reflection outputs are promoted through a pipeline into `persona-state-store`.

**Auto-generated Memory Mind-Map**  
A background job synthesises all stored facts into a navigable memory index — a plain-language mind-map of everything the agent knows, organized by category. Short entries use their actual text (not generic labels), so the index is human-readable and useful for debugging.

---

### 🔍 Production RAG Pipeline

Full Retrieval-Augmented Generation principles are now implemented end-to-end:

- **Reranking** — retrieved candidates are scored and reordered before being injected into context
- **Semantic cache** — previously retrieved results are cached; best-match selection uses similarity as the primary key (with `cachedAt` as tiebreaker only), so higher-quality results always win
- **Document grading** — retrieved documents are graded for relevance before use; configurable toggle to disable if not needed
- **Two retrieval modes** — `interactive` (FTS5-first, low-latency) and `deep` (multi-strategy, higher recall); mode selected automatically based on query context

---

### 🗂️ Task Queue Reliability

The autonomous task queue now has a **watchdog service** that monitors for stale leases, clears expired entries, and alerts on stuck tasks. Lease tracking now correctly clears `expiresAt` when tasks transition to running, preventing premature lease expiry that previously caused tasks to be re-dispatched while still running.

---

### 🛡️ Database Reliability

- **Hard FTS5 capability check** — on startup the plugin verifies the SQLite FTS5 extension is available. If it isn't, the plugin degrades gracefully with a clear alert instead of silently failing queries
- **Provenance tagging** — every fact written by a background cron job is tagged with its source. Prevents cron-written facts from contaminating the interactive memory signal and feedback loops
- **Pre-consolidation flush & decay controls** — operators can now configure flush triggers and decay intervals directly, replacing implicit cron-timing dependencies
- **Defensive connection initialization** — database connections are initialized with explicit open guards, preventing `"database is not open"` errors during gateway hot-reload

---

### 🔧 `verify --test-llm`

The `openclaw hybrid-mem verify` CLI now accepts a `--test-llm` flag that makes a real API call to every configured LLM endpoint, reporting which models are reachable, what embedding dimensions they return, and any auth issues — without having to wait for a failing agent run to find out.

---

## Bug Fixes

| Error | Fix |
|---|---|
| `Error: EventLog is closed` | Replaced permanent closed flag with Node.js `DatabaseSync.open()` reopen path; added `isOpen()` guard in narrative builder |
| `Error: database is not open` | Defensive connection initialization on hot-reload / SIGUSR1 restart |
| `AllEmbeddingProvidersFailed` (two causes) | Fixed provider fallback chain logic; fixed dimension mismatch aborting fallback unnecessarily |
| `No vector column found` (LanceDB) | Query stream handles empty/fresh tables without throwing |
| `Ollama connection failed` | Not reported to error tracker when Ollama is not configured |
| Generic `Connection error` noise | Network / auth / circuit-breaker errors filtered from error tracker |
| Persona reflection skipping promotion | Fixed missing requirements resolution in the reflection pipeline |
| Task queue duplicate dispatch | Prevented double-dispatch when GitHub branch isn't yet visible |
| Gateway register parse failure | Isolated `hybridConfigSchema` to avoid gateway startup crash on extra config keys |
| Upgrade missing LanceDB bindings | Postinstall checks for and rebuilds native bindings when missing |
| Google embedding `gemini-embedding-001` | Updated to current model name (Google renamed `text-embedding-004`/`005`) |
| CI failing on main branch | Fixed concurrency and branch filter in CI workflow |

---

## Changed Behaviour

**Google embedding model:** The Google provider now uses `gemini-embedding-001` (the renamed successor to `text-embedding-004`). If you were using `text-embedding-004` or `text-embedding-005`, update your config — those names no longer resolve.

**Error reporting:** Noisy network errors, auth failures, and circuit-breaker events are now filtered out of the error tracker. You will see fewer spurious alerts; only actionable plugin-internal errors reach GlitchTip/Sentry.

**Bootstrap:** Context-bag and service registration assembly is slimmed down. There is no behaviour change but plugin startup is faster and memory footprint at init is lower.

---

## Upgrade

```bash
openclaw plugin update openclaw-hybrid-memory
# or
openclaw gateway stop
npm install -g openclaw-hybrid-memory@2026.3.250
openclaw gateway start
```

No database migrations required. All stores are backward-compatible with 2026.3.181.

> **Note:** If you were on a version older than 2026.3.181, check the [upgrade guide](../docs/UPGRADE-PLUGIN.md) for any intermediate migration steps.

---

## Known Issues

- `memorySearch.provider` in `agents.defaults` does not yet support `azure-foundry` or other custom providers — only `openai`, `gemini`, `local`, `voyage`, `mistral`, `ollama` are valid. Tracked in [issue #668](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/668).
- MiniMax M2.7-highspeed has an effective context ceiling of ~40K tokens. Use `MiniMax-M2.7` (full model) as primary for long interactive sessions.
