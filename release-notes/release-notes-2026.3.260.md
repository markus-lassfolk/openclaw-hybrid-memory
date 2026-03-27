# Release Notes — OpenClaw Hybrid Memory 2026.3.260

**Release date:** 2026-03-26  
**Previous release:** [2026.3.250](release-notes-2026.3.250.md) (2026-03-24)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md#20263260---2026-03-26)

---

## Overview

A focused stability and usability release following the large 2026.3.250 feature drop. This version resolves every known LanceDB crash path introduced or exposed by 2026.3.250–251, ships **Lineage Tracking** so every memory knows why it was stored, and introduces a **flattened config schema** that makes the plugin configuration easier to read and maintain.

If you were seeing `ENOTEMPTY`, `data file not found`, dimension mismatch errors, or zero crystallization proposals in your logs — this release fixes all of them.

---

## What's New

### 🔍 Lineage Tracking — "Why" Was This Remembered?

Every memory fact, file reference, and decision stored by the plugin now carries a `why` field: a free-text explanation of why it was created. The field is optional (defaults to empty string for backward compatibility) but when supplied it is:

- Indexed in both LanceDB and FTS5, so you can search by reason as well as by content
- Exposed in `memory-tools` so agents can record their reasoning at write time
- Surfaced in the CLI `hybrid-mem vector store` command

This enables provenance queries ("why did I store this fact about the auth module?") and richer audit trails for autonomous agents making long-running decisions.

---

### 📌 Pinned Constraints Survive Context Compaction

Constraints marked as `pinned` in the memory store are now automatically re-injected into the context window immediately **before** compaction runs. Previously, a heavily-loaded context could drop pinned constraints during aggressive compaction — effectively ignoring rules the user had explicitly locked in.

From this version, pinned constraints are guaranteed to be present after every compaction cycle.

---

### 🗂️ Flattened Config Schema

Three config keys that were previously buried inside nested objects have been promoted to top-level plugin config:

| Old path | New top-level key |
|---|---|
| `implicitFeedback.trajectoryLLMAnalysis` | `trajectoryLLMAnalysis` |
| `implicitFeedback.feedToSelfCorrection` | `feedToSelfCorrection` |
| `distill.extractReinforcement` | `extractReinforcement` |

**Backwards compatible:** old nested keys still work and will log a deprecation warning if set alongside the new top-level keys. Top-level keys take precedence. Update your `openclaw.plugin.json` or agent config at your convenience.

---

### 🔗 Timeline Summaries Link to Raw Logs

The session timeline now renders direct links from each summary entry to the underlying raw session log. Jump from a high-level "what happened" summary straight to the exact conversation that produced it.

---

## Bug Fixes

### LanceDB Reliability

| Issue | Fix |
|---|---|
| `ENOTEMPTY` on re-index (LanceDB 0.27.x, #771) | Atomic rename + lock guard prevents concurrent re-index from leaving partial `_tmp` directories |
| `data file not found` in `hasDuplicate()` (#768, #774) | Returns `false` gracefully on fresh stores before first write |
| Vector dimension mismatch crashes fallback queries (#764) | Falls back to FTS-only results instead of crashing when embedding dimensions don't match the stored table |
| Concurrent-close null dereference | Null guard added in the LanceDB close path |

### Memory & Storage

| Issue | Fix |
|---|---|
| `truncateForStorage` crashes on `undefined`/`null` input (#755, #756) | Coerces to empty string before truncation (two separate call sites fixed) |
| SQLite FTS5 "unterminated string" on null bytes (#737, #738) | Input sanitized before FTS5 query construction |
| Crystallization pipeline produces zero proposals (#742, #773) | Logic inversion in candidate scoring fixed; pipeline now produces ranked proposals consistently |

### Config & Schema

| Issue | Fix |
|---|---|
| `selfCorrection` and `implicitFeedback` missing `enabled` in JSON schema (#765, #767) | Both schemas now declare `enabled` explicitly, ending spurious validation warnings |
| `nightlyCycle.enabled` always shown as `false` in CLI config display (#760) | Now reads the live config value correctly |
| `stringEnum` import crash after dependency removal (#762) | Replaced with minimal inline implementation |
| VectorDB schema error suppression too broad (#740, #753) | Suppression now requires `!this.schemaValid`; genuine schema errors surface correctly |

### Providers & Telemetry

| Issue | Fix |
|---|---|
| Transient HTTP 500 from OpenAI reported to GlitchTip (#739, #759) | Server-side 500s filtered from error tracker — no plugin control over these |
| Google embedding `text-embedding-005` returns 404 | Default updated to `gemini-embedding-001` (current model name) |
| Distill description references removed `GOOGLE_API_KEY` | Updated to reference `llm.heavy` tier config |
| Azure embedding row mislabelled in `verify --test-llm` output | Label corrected |


---

## Configuration Migration

If you use any of the following nested keys, migrate them to the new flat top-level keys. The old paths remain functional but will log deprecation warnings:

```jsonc
// Before (still works, but deprecated)
{
  "implicitFeedback": {
    "trajectoryLLMAnalysis": true,
    "feedToSelfCorrection": true
  },
  "distill": {
    "extractReinforcement": true
  }
}

// After (recommended)
{
  "trajectoryLLMAnalysis": true,
  "feedToSelfCorrection": true,
  "extractReinforcement": true
}
```

---

## Upgrade

```bash
openclaw plugin update openclaw-hybrid-memory
# or
openclaw gateway stop
npm install -g openclaw-hybrid-memory@2026.3.260
openclaw gateway start
```

**No database migrations required.** All stores are backward-compatible with 2026.3.250. The new `why` column in LanceDB is added lazily on first write — existing records will have an empty `why` field.

> **Upgrading from before 2026.3.250?** Check [release-notes-2026.3.250.md](release-notes-2026.3.250.md) for the larger set of changes and any intermediate migration steps.

---

## Known Issues

- `memorySearch.provider` in `agents.defaults` does not yet support `azure-foundry` or other custom providers — only `openai`, `gemini`, `local`, `voyage`, `mistral`, `ollama` are valid. Tracked in [#668](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/668).
- MiniMax M2.7-highspeed has an effective context ceiling of ~40K tokens. Use `MiniMax-M2.7` (full model) as primary for long interactive sessions.
