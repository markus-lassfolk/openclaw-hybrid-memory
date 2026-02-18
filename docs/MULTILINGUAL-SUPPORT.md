# Multi-language support

This document describes how the memory-hybrid extension supports multiple languages for **trigger detection**, **category detection**, **decay classification**, and **session distillation**, and what you need to know to use and verify it.

---

## Overview

- **English is the single source of truth** for keyword intents. Trigger, category, and decay patterns are hardcoded in English in the extension.
- **Other languages are added dynamically** via a generated file: `.language-keywords.json`, next to your SQLite facts DB (e.g. `~/.openclaw/memory/.language-keywords.json`).
- That file is produced by **`openclaw hybrid-mem build-languages`**, which:
  1. Samples text from your existing facts
  2. Asks an LLM to detect the **top 3 languages** (ISO 639-1, e.g. `en`, `sv`, `de`)
  3. Asks the LLM to generate **intent-based equivalents** (not literal translations) for triggers, category keywords, decay keywords, structural trigger phrases, and extraction building blocks
- At runtime, **all those keywords are merged** with English. So when the system decides “should we capture this message?” or “what category/decay does this fact get?”, it matches against **English + every language in the file**.

So: multi-language support is **data-driven and derived from your own memory content**. The more diverse your stored facts, the better the detected languages and the better the coverage for capture/category/decay in those languages.

---

## How it works (implementation)

### 1. Keyword storage and loading

| Layer | Location | Role |
|-------|----------|------|
| **English (source of truth)** | `extensions/memory-hybrid/utils/language-keywords.ts` → `ENGLISH_KEYWORDS` | Hardcoded trigger words, categoryDecision, categoryPreference, categoryEntity, categoryFact, decayPermanent, decaySession, decayActive. |
| **Dynamic languages** | `.language-keywords.json` (same directory as `facts.db`) | Per-language `translations` (same key groups as English), optional `triggerStructures`, optional `extraction` templates. |
| **Path** | Set at plugin init via `setKeywordsPath(dirname(resolvedSqlitePath))` so the file is always next to the SQLite DB. |

- **Loading:** `loadMergedKeywords()` reads the JSON (if present), merges each keyword group with English (union of all languages), and caches the result. If the file is missing or invalid, only English is used.
- **Caching:** Merged keywords and trigger structures are cached per file path. The cache is cleared when a new `.language-keywords.json` is written (e.g. after `build-languages` or auto-build).

### 2. Intent-based generation (not literal translation)

The build uses **intents** so that other languages get natural phrasing, word order, and idioms instead of word-for-word translation. Intents are defined in `extensions/memory-hybrid/services/intent-template.ts`:

- **Keyword groups** (`KEYWORD_GROUP_INTENTS`): e.g. “phrases that indicate the user wants to remember something”, “phrases that signal a past decision”, “phrases that indicate temporary session state”.
- **Structural trigger phrases** (`STRUCTURAL_TRIGGER_INTENTS`): e.g. first-person preference (“I prefer X”), possessive fact (“my X is Y”), always/never rules.
- **Extraction building blocks** (`EXTRACTION_INTENTS`): e.g. decision verbs/connectors, choice-over rejectors, possessive words, preference verbs — for future use in language-aware fact extraction.

The LLM is asked to produce **natural equivalents** for each target language (and optionally extraction blocks). Output is normalized and then written into `.language-keywords.json` (version 2 format with `translations`, `triggerStructures`, and `extraction`).

### 3. Where multilingual keywords are used

| Use | Function / module | What uses merged keywords |
|-----|-------------------|---------------------------|
| **Should we capture this message?** | `shouldCapture(text)` in `index.ts` | `getMemoryTriggerRegexes()` → list of regexes built from merged **triggers** + **triggerStructures** (and universal patterns: phone, email). If any regex matches, the message is a candidate for capture. |
| **Which category?** | `detectCategory(text)` in `index.ts` | `getCategoryDecisionRegex()`, `getCategoryPreferenceRegex()`, `getCategoryEntityRegex()`, `getCategoryFactRegex()` — all from merged keyword groups. |
| **Which decay class?** | `classifyDecay(...)` in `utils/decay.ts` | `getDecayPermanentRegex()`, `getDecaySessionRegex()`, `getDecayActiveRegex()` from merged keywords (plus entity/key rules). |
| **Session distillation** | `prompts/distill-sessions.txt` | Instructs the LLM to extract facts in **every language present** and to output fact text in the **same language** as the source. No keyword file is used here; it’s prompt-based. |

So: **capture, category, and decay** all use the merged (English + file) keywords; **distillation** is multi-language by prompt only.

### 4. Extraction templates (v2, prepared for future use)

`.language-keywords.json` can store per-language **extraction** templates (e.g. decision verbs, possessive words, preference verbs). These are loaded and exposed as `getExtractionTemplates()`. The runtime does **not** yet use them for parsing or extracting structured fields from text; they are available for future language-aware extraction logic.

### 5. Auto-build behaviour

- **Config:** `languageKeywords.autoBuild` (default `true`) and `languageKeywords.weeklyIntervalDays` (default `7`) in plugin config.
- **Startup:** If `languageKeywords.autoBuild` is true and `.language-keywords.json` does **not** exist, a one-shot build is scheduled 3 seconds after plugin start (so the DB is ready). It uses up to 300 facts from `getFactsForConsolidation(300)`, the same OpenAI client as the rest of the plugin, and `autoClassify.model` (e.g. `gpt-4o-mini`).
- **Periodic:** A timer runs the same build every `weeklyIntervalDays` days. That way, as new languages appear in your memory, the file can be updated (language drift).
- **After build:** If the build succeeds and added at least one language, a log line reports “language keywords updated (…, +N languages)”. The keyword cache is cleared so the next capture/category/decay use the new file.

---

## What the user has to be aware of

1. **English is always on**  
   You don’t need to do anything for English; it’s built-in. Other languages are additive.

2. **Other languages require `.language-keywords.json`**  
   Until that file exists and contains a language, only English (and universal patterns like phone/email) are used for triggers/category/decay. So:
   - First time or new environment: run **`openclaw hybrid-mem build-languages`** once (or rely on auto-build 3s after start if the file is missing).
   - If you add a lot of content in a new language, run **`build-languages`** again (or wait for the next weekly run) so that language is detected and added.

3. **Language detection is based on your stored facts**  
   The build samples from `getFactsForConsolidation(300)`. If your memory is mostly English, the “top 3” may be `["en"]` and no extra languages are added. Add or distill content in other languages first, then run `build-languages`.

4. **LLM and API usage**  
   `build-languages` uses the same OpenAI API as the rest of the plugin (embedding API key). It calls the LLM twice: once for language detection, once for intent-based keyword generation. Model is configurable (e.g. `--model gpt-4o-mini` or your `autoClassify.model`).

5. **File location**  
   The file is **next to `facts.db`** (e.g. `~/.openclaw/memory/.language-keywords.json`). Don’t move or delete it unless you want to fall back to English-only until the next build.

6. **Distillation is multi-language by prompt**  
   Session distillation (`distill-sessions.txt`) tells the model to extract facts in every language and to keep the fact text in the source language. That does **not** depend on `.language-keywords.json`; it’s independent.

7. **Extraction templates**  
   The `extraction` section in `.language-keywords.json` is generated and loaded for future use. Currently no runtime code uses it for parsing; only trigger/category/decay use the file.

---

## What to think about (design / ops)

- **Order of operations:** For a new user with a lot of non-English content, either run `build-languages` after some facts exist, or rely on auto-build (first run may still be English-only if the sample is small). After the first successful build, weekly runs will pick up new languages as the store evolves.
- **Quality:** Intent-based generation gives better natural phrasing than literal translation. If you see missed captures or wrong categories in a given language, run `build-languages` again (and optionally try a stronger model) so the LLM can refine the keywords.
- **Security/privacy:** Build sends a sample of fact text to the LLM. If your facts are sensitive, consider disabling auto-build and running `build-languages` only in a controlled environment or with a model that meets your policy.
- **Offline / no-API:** If the plugin runs without OpenAI (or with embedding-only), auto-build and manual `build-languages` will fail when they call the LLM. In that case, multi-language support is limited to whatever was already in `.language-keywords.json` (or English-only if the file is missing).

---

## How to check it’s working

### 1. File exists and has content

```bash
# Path: same directory as facts.db (default ~/.openclaw/memory)
ls -la ~/.openclaw/memory/.language-keywords.json
cat ~/.openclaw/memory/.language-keywords.json | head -80
```

You should see:
- `"version": 2`
- `"topLanguages": ["en", "sv", ...]` (or similar)
- `"translations": { "sv": { "triggers": [...], ... }, ... }`
- Optionally `"triggerStructures"` and `"extraction"`

### 2. Run build and inspect output

```bash
openclaw hybrid-mem build-languages
# Expect: "Detected languages: en, sv, de" (or similar)
#          "Languages added (translations): 2" (or similar)
#          "Path: /path/to/.language-keywords.json"
```

Use `--dry-run` to see what would be detected and generated without writing the file:

```bash
openclaw hybrid-mem build-languages --dry-run
```

### 3. Trigger/category/decay behaviour

- **Capture:** Say or paste a sentence in a non-English language that clearly expresses a preference or a fact (e.g. “Jag föredrar mörkt läge” / “Ich bevorzuge dunklen Modus”). After the next capture cycle, check that a fact was stored (e.g. via `openclaw hybrid-mem search <query>` or `lookup`). If the file was missing or had no that language, that sentence might not have triggered capture.
- **Category:** Store a fact in another language and check its category (e.g. in DB or via a tool that returns category). It should be classified as preference/decision/fact/entity/other using the merged keywords.
- **Decay:** Store a fact that matches “session” or “active” phrasing in another language and confirm its decay class (e.g. session or active) in the DB or UI.

### 4. Logs

When auto-build runs:

- “no language keywords file; building from memory samples in 3s…” (startup, file missing)
- “language keywords updated (en, sv, de, +2 languages)” (build succeeded, languages added)
- “language keywords build done (en, sv, de)” (build succeeded, no new languages)
- “language keywords build failed: …” (build or write error)

### 5. Config

In `~/.openclaw/openclaw.json`, under the memory-hybrid plugin config:

```json
"languageKeywords": {
  "autoBuild": true,
  "weeklyIntervalDays": 7
}
```

If `autoBuild` is `false`, the file is never auto-created or updated; you must run `build-languages` manually.

---

## Configuration reference

| Key | Default | Description |
|-----|---------|-------------|
| `languageKeywords.autoBuild` | `true` | If true, build `.language-keywords.json` once at startup when missing (after 3s), then every `weeklyIntervalDays` days. |
| `languageKeywords.weeklyIntervalDays` | `7` | Interval in days for automatic language keyword rebuild. Capped at 30. |

Example to disable auto-build and run only manually:

```json
"languageKeywords": {
  "autoBuild": false,
  "weeklyIntervalDays": 7
}
```

---

## CLI reference

| Command | Description |
|--------|-------------|
| `openclaw hybrid-mem build-languages [--dry-run] [--model <model>]` | Detect top 3 languages from fact samples, generate intent-based keywords for those languages, and write `.language-keywords.json` next to the SQLite DB. Default model: `gpt-4o-mini` (or your autoClassify model). `--dry-run`: detect and generate but do not write the file. |

See [CLI-REFERENCE.md](CLI-REFERENCE.md) for the full command list.

---

## Summary

- **Multi-language support** = English (hardcoded) + dynamic languages from `.language-keywords.json`.
- **Build** = sample facts → LLM detects top 3 languages → LLM generates intent-based keywords (and optionally extraction blocks) → write file; optional **auto-build** at startup (if file missing) and every N days.
- **Use:** merged keywords drive **capture** (trigger regexes), **category** (decision/preference/entity/fact), and **decay** (permanent/session/active). **Distillation** is multi-language via prompt only.
- **User:** ensure the file exists (run `build-languages` or rely on auto-build), add non-English content if you want more languages detected, and use the checks above to verify behaviour.
