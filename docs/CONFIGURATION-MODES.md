# Configuration Modes

**Regression tests:** `extensions/memory-hybrid/tests/config-presets-doc-sync.test.ts` asserts `PRESET_OVERRIDES` and post-parse (Phase 1) behavior match this document. Update that file when you change presets or Phase 1.

You can set a **mode** in plugin config to apply a preset of feature toggles. **If you don't set `mode`, the default is `local`** (cost-safety: no external LLM, FTS-only). Set `minimal`, `enhanced`, or `complete` to enable LLM and richer features.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "mode": "minimal",
          "embedding": { "apiKey": "env:OPENAI_API_KEY", "model": "text-embedding-3-small" }
        }
      }
    }
  }
}
```

Valid values: **`local`** | **`minimal`** | **`enhanced`** | **`complete`**. Default when omitted: **`local`**. If you change any feature away from the preset, the effective mode is reported as **Custom** in `openclaw hybrid-mem config`.

**Migration from older versions:** If your config still has a deprecated mode name (`essential`, `normal`, `expert`, or `full`), the plugin **resets** it to **`local`** and logs a one-time warning. To use LLM or other features, set the new mode explicitly (e.g. `"mode": "minimal"` or `"mode": "complete"`). New names: `local`, `minimal`, `enhanced`, `complete`.

---

## What each mode does

The table below is the **intent** of each preset in code (`PRESET_OVERRIDES` in `extensions/memory-hybrid/config/utils.ts`). See **Phase 1 baseline** (subsection below) for features that are **always** overridden at parse time on current plugin versions.

| Mode | Best for | Description |
|------|----------|-------------|
| **Complete** | Rich defaults, verbose logging | Same **preset toggles** as Enhanced (see matrix), plus **`verbosity`: `verbose`**. Does **not** turn on query expansion, workflow tracking, dream-cycle, documents, etc. by default — those stay off in the preset; enable them explicitly in config if you want them. |
| **Enhanced** | Step up from Minimal | Adds entity lookup on recall, credential auto-capture hooks (when vault is configured), **`store.classifyBeforeWrite`**, **`graph.autoLink`**, reflection, self-correction. Advanced opt-ins (workflow tracking, nightly cycle, documents, reranking, …) remain **off** in the preset unless you enable them. |
| **Minimal** | Low cost, nano/flash only | Balanced: capture, recall, auto-classify, graph, procedures, ingest paths; no reflection; **`entityLookup`** off; **`authFailure`** recall on. **All LLM use (distill, auto-classify, ingest) is restricted to nano or flash-tier models** to keep cost very low. Credentials vault off unless you set an encryption key. |
| **Local** | No external LLM | Auto-capture and auto-recall with **`retrieval.strategies`: `["fts5"]` only**. **`autoClassify`**, graph, procedures, reflection off. **`verbosity`: `quiet`**. Ideal for offline / Pi-style setups. |
| **Custom** | Your own mix | Reported when your config does not match any preset (you changed at least one preset-controlled toggle). Your explicit settings are used. |

### Phase 1 baseline

After preset merge, **`applyPhase1CoreOnlyMigration`** in `extensions/memory-hybrid/config/parsers/index.ts` runs on current releases. It **always** sets:

- **`queryExpansion.enabled`** → `false` (all modes; opt in explicitly to enable HyDE / expansion).
- **`credentials.autoDetect`** → `false` (opt in explicitly).
- **`graph.strengthenOnRecall`** → `false`.
- For each key in **`PHASE1_CORE_ONLY_FORCE_DISABLED_KEYS`** (e.g. `frustrationDetection`, `nightlyCycle`, `passiveObserver`, `workflowTracking`, `selfExtension`, `crystallization`, `verification`, `provenance`, `aliases`, `crossAgentLearning`, `reranking`, `contextualVariants`, `documents`, `personaProposals`), the effective config keeps **`enabled: false`** unless you later override after parse (same intent as the presets: advanced features are opt-in).

So **`openclaw hybrid-mem config`** may show query expansion and several “advanced” features off even for **`mode: "complete"`** — that matches the **code**, not an older marketing blurb about “everything on.”

To reduce API or compute usage, set `"mode": "minimal"` or `"mode": "local"` in your plugin config.

---

## Minimal mode: nano + flash

In **Minimal** mode, the preset uses:

- **Distill** (session logs → facts): `distill.extractionModelTier` is set to **default (flash)** so extraction quality is good while cost stays low.
- **Auto-classify**: uses the **nano** tier (e.g. `llm.nano` or lightest configured model).

This gives good value at low cost. For even lower cost or fully offline use, use **Local** (no external LLM). See [FEATURES-AND-TIERS.md](FEATURES-AND-TIERS.md) for the full feature/tier matrix.

---

## Credentials vault and credential capture

- **Encrypted credentials vault** (`credentials.enabled`): Stores API keys, tokens, passwords in a SQLite vault (encrypted when a key is configured). **Local** and **Minimal** presets set **`credentials.enabled: true`** so the vault is on; add **`credentials.encryptionKey`** (16+ chars, or `env:VAR`) for encryption at rest. Without a key, the plugin warns and stores secrets in plaintext in the vault DB — restrict filesystem access or add a key.

  | Mode    | Vault default | Note |
  |---------|----------------|------|
  | Local   | On | Preset enables vault; encryption requires `credentials.encryptionKey` (or env). |
  | Minimal | On | Same as Local. |
  | Enhanced | On (if key set) | Preset does not set `enabled: true`; vault turns on when a valid encryption key is present. |
  | Complete | On (if key set) | Same as Enhanced. |

  **`credentials.autoDetect`** is forced **off** by Phase 1 until you set it in config (even when Enhanced/Complete presets list `autoDetect: true`).

- **Credentials auto-detect** (`credentials.autoDetect`): Detects credential-like content in conversation and prompts to store in the vault. Presets may set **`autoDetect: true`** for Enhanced/Complete, but **Phase 1 (≥ 2026.3.140)** forces **`autoDetect: false`** until you opt in explicitly.

- **Credentials capture from tool I/O** (`credentials.autoCapture.toolCalls`): Scans **tool call inputs and outputs** for credential patterns and stores them in the vault. **Local and Minimal** leave it off; **Enhanced and Complete** enable it when the vault is on (you can still turn it on manually in Local/Minimal).

  | Mode     | credentials.autoCapture.toolCalls |
  |----------|-----------------------------------|
  | Local    | Off                               |
  | Minimal  | Off                               |
  | Enhanced | On (when vault enabled)           |
  | Complete | On (when vault enabled)           |

---

## Feature matrix (on/off by mode)

Below, **✓** = enabled by preset, **—** = disabled by preset, **opt** = optional / depends on other config (e.g. vault only when key set).

| Feature | Local | Minimal | Enhanced | Complete |
|---------|:-----:|:-------:|:--------:|:--------:|
| **Core** |
| autoCapture | ✓ | ✓ | ✓ | ✓ |
| autoRecall | ✓ | ✓ | ✓ | ✓ |
| autoClassify | — | ✓ | ✓ | ✓ |
| autoClassify.suggestCategories | — | ✓ | ✓ | ✓ |
| **Store** |
| store.fuzzyDedupe | ✓ | — | ✓ | ✓ |
| store.classifyBeforeWrite | — | — | ✓ | ✓ |
| **Credentials** |
| credentials (vault) | ✓ | ✓ | opt | opt |
| credentials.autoDetect | — | — | ✓ | ✓ |
| credentials.autoCapture.toolCalls | — | — | ✓ | ✓ |
| **Graph** |
| graph | — | ✓ | ✓ | ✓ |
| graph.autoLink | — | — | ✓ | ✓ |
| graph.useInRecall | — | ✓ | ✓ | ✓ |
| **Procedures** |
| procedures | — | ✓ | ✓ | ✓ |
| procedures.requireApprovalForPromote | — | ✓ | ✓ | ✓ |
| **Other** |
| reflection | — | — | ✓ | ✓ |
| wal | ✓ | ✓ | ✓ | ✓ |
| languageKeywords.autoBuild | — | ✓ | ✓ | ✓ |
| personaProposals (preset) | — | — | — | — |
| personaProposals.autoApply | — | — | — | — |
| memoryTiering | — | ✓ | ✓ | ✓ |
| memoryTiering.compactionOnSessionEnd | — | ✓ | ✓ | ✓ |
| selfCorrection | — | — | ✓ | ✓ |
| selfCorrection.semanticDedup | — | — | ✓ | ✓ |
| selfCorrection.applyToolsByDefault | — | — | ✓ | ✓ |
| autoRecall.entityLookup | — | — | ✓ | ✓ |
| autoRecall.entityLookup.autoFromFacts | — | — | (default true) | (default true) |
| autoRecall.entityLookup.maxAutoEntities | — | — | (default 500, max 2000) | (default 500, max 2000) |
| autoRecall.authFailure | — | ✓ | ✓ | ✓ |
| autoRecall.interactiveEnrichment | fast | fast | fast | fast |
| queryExpansion.enabled | — | — | — | — |
| ingest (paths) | — | ✓ | ✓ | ✓ |
| distill.extractDirectives | ✓ | ✓ | ✓ | ✓ |
| distill.extractReinforcement | — | ✓ | ✓ | ✓ |
| distill.extractionModelTier | — | **default (flash)** | default | default |
| errorReporting | — | — | opt | opt |
| **Advanced / opt-in** (preset: off unless noted) |
| workflowTracking | — | — | — | — |
| nightlyCycle (dream-cycle) | — | — | — | — |
| passiveObserver | — | — | — | — |
| extraction (`extractionPasses` etc.) | — | — | ✓ | ✓ |
| selfExtension (tool proposals) | — | — | — | — |
| crystallization (skill proposals) | — | — | — | — |
| **Verification / provenance / retrieval** |
| verification | — | — | — | — |
| provenance | — | — | — | — |
| documents | — | — | — | — |
| aliases | — | — | — | — |
| crossAgentLearning | — | — | — | — |
| reranking | — | — | — | — |
| contextualVariants | — | — | — | — |
| **Verbosity level** | quiet | normal | normal | verbose |

**Notes:**

- **opt** (Enhanced/Complete vault): Vault is on when `credentials.encryptionKey` resolves to a valid key (or you set `credentials.enabled: true`). In Enhanced/Complete, `autoDetect` and `autoCapture.toolCalls` apply when the vault is enabled. **Local/Minimal** turn the vault on in the preset without requiring a key (use a key for encryption).
- **personaProposals.autoApply**: Never set by any preset (always **—**). When enabled, approved persona proposals are applied to identity files without human review. **Opt-in only** — no mode turns this on by default.
- **Minimal** uses only nano/flash-tier models for distill, auto-classify, and ingest to keep cost very low. **Local** uses no external LLM (FTS-only recall).
- **autoRecall.entityLookup** (Enhanced/Complete): With `entityLookup.enabled` true, if **`entities` is empty or omitted** and **`autoFromFacts`** is true (default), names come from distinct non-null `entity` values on active facts (`FactsDb.getKnownEntities()`), sorted deterministically and capped by **`maxAutoEntities`** (default 500, hard max 2000). Set **`autoFromFacts`** to `false` for the legacy behavior: no entity-centric merge or `entityMentioned` directives until you set an explicit **`entities`** list. If **`entities`** is non-empty, only that list is used. Run `openclaw hybrid-mem config` to see whether the resolved source is `auto from facts (cap N)` or `N configured name(s)`.
- **Advanced / opt-in:** In **`PRESET_OVERRIDES`**, workflow tracking, dream-cycle, passive observer, verification, provenance, documents, aliases, cross-agent learning, reranking, contextual variants, self-extension, and crystallization are **`enabled: false`** for **Enhanced** and **Complete** (opt-in only). **`extraction.extractionPasses`** is `true` in those presets (multi-pass extraction flags). **Phase 1** (see above) keeps the same “off unless you opt in” behavior for the disabled keys. Users can enable any feature explicitly via config.
- **personaProposals.autoApply** is `false` in **all** presets — it is never set automatically. Enable it only if you want the agent to modify identity files without human review. See [PERSONA-PROPOSALS.md](PERSONA-PROPOSALS.md) for risks and the audit trail.

---

## Overriding the preset

Any key you set in config **overrides** the preset. So you can start from a mode and tweak:

```json
{
  "config": {
    "mode": "minimal",
    "embedding": { "apiKey": "env:OPENAI_API_KEY", "model": "text-embedding-3-small" },
    "reflection": { "enabled": true }
  }
}
```

Here you get Minimal preset but with reflection enabled. Verify will report **Mode: Custom** because the resolved config no longer matches the Minimal preset.

### Array override behavior

**Important:** When you override an array config value, your array **replaces** the preset array entirely — arrays are **not concatenated or merged**.

For example, if the preset sets:
```json
"autoRecall": { "entityLookup": { "entities": ["user", "owner"] } }
```

And you set:
```json
"autoRecall": { "entityLookup": { "entities": ["project"] } }
```

The final result is `["project"]` (your value), **not** `["user", "owner", "project"]`. This applies to all array config fields (e.g., `ingest.paths`, `autoRecall.authFailure.patterns`).

### Empty `entities` and auto-from-facts

If you enable entity lookup but omit **`entities`** (or set `"entities": []`), the plugin uses **`autoRecall.entityLookup.autoFromFacts`** (default `true`) to load names from stored facts, up to **`maxAutoEntities`**. To require a manual list and avoid that until configured, set `"autoFromFacts": false`.

---

## See also

- [tests/config-presets-doc-sync.test.ts](../extensions/memory-hybrid/tests/config-presets-doc-sync.test.ts) — preset + Phase 1 guardrails (run with `npm test` in `extensions/memory-hybrid`).
- [CONFIGURATION.md](CONFIGURATION.md) — Full config reference.
- [CREDENTIALS.md](CREDENTIALS.md) — Vault setup, migration, and credential capture from tool I/O.
