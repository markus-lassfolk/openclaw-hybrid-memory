---
layout: default
title: Multilingual Language Keywords
parent: Features
nav_order: 1
---
# Multilingual Language Keywords

Memory capture (auto-capture, category detection, decay classification, and distillation) uses **keyword and phrase patterns** to decide what to store and how to classify it. By default only **English** patterns are hardcoded. The plugin can **detect the main languages** used in your memory and **generate equivalent patterns** for those languages, then **reuse them automatically** so that conversations in Swedish, German, or any other detected language are captured and classified correctly.

This avoids the “Doris has 297 facts vs 2,688” effect: if one user (or persona) mostly speaks Swedish, auto-capture and category logic will still fire once Swedish (and other detected languages) are added via the language keywords system.

---

## Overview

| Component | Role |
|-----------|------|
| **English keywords** | Single source of truth in code: triggers, categoryDecision, categoryPreference, categoryEntity, categoryFact, decay*, correctionSignals. |
| **`.language-keywords.json`** | Stored next to `facts.db`. Contains **translations** (intent-based equivalents) and optional **structural trigger phrases** and **extraction building blocks** per language. |
| **Runtime** | At runtime the plugin **merges** English + file contents and builds regexes for `shouldCapture`, `detectCategory`, `classifyDecay`, and (when used) correction-signal detection and extraction. |
| **Auto-build** | Optional **automatic** build: once at **first startup** if no file exists, then **weekly** (configurable). No need to run `build-languages` manually unless you want an immediate refresh. |

---

## How it works

1. **Triggering capture** (`shouldCapture`)  
   Message text is tested against **memory trigger** patterns. Those patterns are built from:
   - Merged **trigger keywords** (English + all languages in the file)
   - **Structural phrases** from the file (e.g. “I prefer …”, “my X is …”) when present
   - Universal patterns (phone, email) that are language-agnostic  

   If the user says the same thing in another language (e.g. “jag föredrar …” instead of “I prefer …”), it is only captured when that language’s equivalents are in the file.

2. **Category detection** (`detectCategory`)  
   Captured text is classified as decision, preference, entity, fact, or other using **category** keyword regexes. Those regexes are built from merged **categoryDecision**, **categoryPreference**, **categoryEntity**, **categoryFact** (English + file). So e.g. Swedish “bestämde”, “föredrar”, “heter” can be recognized once in the file.

3. **Decay classification** (`classifyDecay`)  
   Decay (permanent / stable / active / session) uses **decayPermanent**, **decaySession**, **decayActive** keyword regexes (English + file). Again, other languages work once their equivalents are in the file.

4. **Correction signals** (optional)  
   If the plugin uses correction/nudge detection, it uses **correctionSignals** (English + file) so e.g. “du missförstod” can be recognized.

5. **Structured extraction** (optional)  
   When the file contains **extraction** building blocks per language, the plugin can build **extraction** regexes (decision verbs, possessive patterns, “is called” verbs, etc.) so entity/key/value parsing works in multiple languages.

---

## Auto-build (enabled by default)

To give the best experience without manual steps:

- **First startup:** If `.language-keywords.json` does **not** exist next to `facts.db`, the plugin schedules a **one-off build** a few seconds after startup (async, non-blocking). It samples recent facts, detects top languages, calls the LLM to generate intent-based equivalents, and writes the file. After that, capture and category logic use English + the new languages.
- **Ongoing:** A **weekly** (or configurable interval) job runs the same build so that if usage **drifts** (e.g. more Swedish over time), the file is updated and triggers/categories stay in sync.

So in **new** and **upgraded** setups, multilingual keywords are **enabled by default** unless you turn them off (see [Configuration](#configuration)).

---

## Configuration

In `openclaw.json`, under the memory-hybrid plugin `config`:

```json
{
  "languageKeywords": {
    "autoBuild": true,
    "weeklyIntervalDays": 7
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `autoBuild` | `true` | When `true`, run build once at startup if no language file exists, and on a weekly (or configured) interval. When `false`, no automatic build; you can still run `openclaw hybrid-mem build-languages` manually. |
| `weeklyIntervalDays` | `7` | Interval in days between automatic builds (1–30). Only applies when `autoBuild` is `true`. |

To **disable** automatic language building (e.g. to avoid LLM calls or to control when it runs):

```json
"languageKeywords": { "autoBuild": false }
```

You can still run `openclaw hybrid-mem build-languages` manually whenever you want to refresh the file.

---

## CLI: build-languages

Manual build (detect languages from memory samples, generate and write `.language-keywords.json`):

```bash
openclaw hybrid-mem build-languages [--dry-run] [--model <model>]
```

| Option | Description |
|--------|-------------|
| `--dry-run` | Run detection and generation but do **not** write the file. |
| `--model <model>` | LLM model for detection and generation (default: same as `autoClassify.model`, e.g. `gpt-4o-mini`). |

The command:

1. Samples up to 300 recent facts from the DB.
2. Sends a subset to the LLM to **detect the top 3 languages** (ISO 639-1).
3. Asks the LLM for **intent-based equivalents** of the English keyword groups (and optional structural phrases and extraction blocks) in those languages.
4. Writes `.language-keywords.json` next to your `facts.db` (unless `--dry-run`).

After a successful run, the plugin’s in-memory keyword cache is cleared so the next capture/category/decay use the new file.

---

## File location and format

- **Path:** Same directory as the SQLite DB (e.g. `~/.openclaw/memory/.language-keywords.json`).
- **Name:** `.language-keywords.json`.

**Minimal shape** (keyword translations only):

```json
{
  "version": 1,
  "detectedAt": "2025-02-18T12:00:00.000Z",
  "topLanguages": ["en", "sv", "de"],
  "translations": {
    "sv": {
      "triggers": ["kom ihåg", "föredrar", "bestämde", ...],
      "categoryDecision": [...],
      "categoryPreference": [...],
      "categoryEntity": [...],
      "categoryFact": [...],
      "decayPermanent": [...],
      "decaySession": [...],
      "decayActive": [...],
      "correctionSignals": [...]
    },
    "de": { ... }
  }
}
```

**Extended shape** (with structural triggers and extraction building blocks):

- `triggerStructures`: per-language arrays of phrase patterns used for trigger regexes (e.g. “jag föredrar”, “mitt X är”).
- `extraction`: per-language objects with e.g. `decision.verbs`, `decision.connectors`, `possessive.possessiveWords`, `preference.verbs`, `nameIntro.verbs`, etc., used to build safe extraction regexes.

The plugin only **reads** this file; it is written by the auto-build or by `build-languages`. Do not edit it by hand unless you know the schema; prefer re-running the build to refresh.

---

## When to run build-languages manually

- You’ve just added a lot of content in a new language and want the file updated **now** (instead of waiting for the next weekly run).
- You disabled `autoBuild` and want to refresh the file on a schedule of your choice.
- You’re debugging or testing the multilingual pipeline.

---

## Testing that it works

1. **Config and defaults**  
   - Omit `languageKeywords` → parsed config should have `languageKeywords: { autoBuild: true, weeklyIntervalDays: 7 }`.  
   - Set `autoBuild: false` → no automatic build; weekly timer not started.  
   - Set `weeklyIntervalDays: 14` → interval 14 days (capped 1–30).

2. **No file / English only**  
   - With no `.language-keywords.json` (and no path set, or path set but file missing), `loadMergedKeywords()` should return only English keyword lists.  
   - Trigger/category/decay regexes should match English phrases and not match e.g. Swedish until a file is present.

3. **With file**  
   - Write a minimal `.language-keywords.json` with one language (e.g. `sv`) and one group (e.g. `triggers: ["föredrar"]`).  
   - Set the keywords path, clear cache, then `loadMergedKeywords()`.  
   - Merged `triggers` should include both English and “föredrar”.  
   - `getMemoryTriggerRegexes()` / `getCategoryPreferenceRegex()` (etc.) should match the Swedish phrase.

4. **Build service**  
   - `collectSamplesFromFacts([{ text: "a".repeat(30) }, ...])` should return samples (respecting max length and dedup).  
   - With a mock OpenAI that returns a fixed language array and a fixed translations object, `runBuildLanguageKeywords(...)` should write a file and return `ok: true` with the expected path and language count.

5. **Install defaults**  
   - The config applied by `openclaw hybrid-mem install` should include `languageKeywords: { autoBuild: true, weeklyIntervalDays: 7 }` so new/upgraded setups get auto-build by default.

See the repo test files `tests/language-keywords.test.ts` and `tests/language-keywords-build.test.ts` for concrete cases.

---

## Related

- [Configuration](CONFIGURATION) — `languageKeywords` and other plugin options.
- [CLI Reference](CLI-REFERENCE) — `build-languages` and other commands.
- [Session Distillation](SESSION-DISTILLATION) — the distill prompt is instructed to extract from **all languages** and to output fact text in the source language; combined with language keywords, capture and batch extraction both work multilingually.
