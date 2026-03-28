# Configuration Modes

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

| Mode | Best for | Description |
|------|----------|-------------|
| **Complete** | **Full experience (opt-in)** | Everything enabled: capture, recall, classification, graph, procedures, reflection, tiering, persona proposals, self-correction, query expansion, ingest, dream-cycle, passive observer, workflow tracking, tool/skill proposals, verification, provenance, documents, aliases, cross-agent learning, reranking, contextual variants. Credentials vault and tool I/O capture on when vault is configured. Highest capability and API use. |
| **Enhanced** | Like Complete with slightly less | Same as Complete but no query expansion and no documents (no MarkItDown-based doc ingestion). Includes ingest, verification, provenance, aliases, cross-agent learning, reranking, contextual variants, dream-cycle, passive observer, workflow tracking, tool/skill proposals. Good if you want most features but want to trim a few. |
| **Minimal** | Low cost, nano/flash only | Balanced: capture, recall, auto-classify, graph, procedures, ingest (run ingest-files when you want to seed from docs); no reflection, no persona proposals, no credential capture from tool I/O. **All LLM use (distill, auto-classify, ingest) is restricted to nano or flash-tier models** to keep cost very low. Credentials vault off unless you set an encryption key. |
| **Local** | No external LLM | Only core memory: auto-capture and auto-recall with **FTS-only** retrieval. No embeddings, no classification, graph, procedures, or reflection. Zero external API calls — local SQLite + files only. Ideal for Raspberry Pi or fully offline setups. |
| **Custom** | Your own mix | Reported when your config does not match any preset (you changed at least one toggle). Your explicit settings are used. |

To reduce API or compute usage, set `"mode": "minimal"` or `"mode": "local"` in your plugin config.

---

## Minimal mode: nano + flash

In **Minimal** mode, the preset uses:

- **Distill** (session logs → facts): `distill.extractionModelTier` is set to **default (flash)** so extraction quality is good while cost stays low.
- **Auto-classify**: uses the **nano** tier (e.g. `llm.nano` or lightest configured model).

This gives good value at low cost. For even lower cost or fully offline use, use **Local** (no external LLM). See [FEATURES-AND-TIERS.md](FEATURES-AND-TIERS.md) for the full feature/tier matrix.

---

## Credentials vault and credential capture

- **Encrypted credentials vault** (`credentials.enabled`): Stores API keys, tokens, passwords in an encrypted SQLite vault instead of in plain facts. Requires `credentials.encryptionKey` (or `env:OPENCLAW_CRED_KEY`).

  | Mode    | Vault default | Note |
  |---------|----------------|------|
  | Local   | Off  | No vault; use env vars for secrets if needed. |
  | Minimal | Off  | Opt-in: set encryption key to enable. |
  | Enhanced | On (if key set) | Preset turns vault on when key is present. |
  | Complete | On (if key set) | Same as Enhanced. |

- **Credentials auto-detect** (`credentials.autoDetect`): Detects credential-like content in conversation and prompts to store in the vault. **Enhanced / Complete** enable this when the vault is on.

- **Credentials capture from tool I/O** (`credentials.autoCapture.toolCalls`): Scans **tool call inputs and outputs** for credential patterns and stores them in the vault. **Local and Minimal** leave it off; **Enhanced and Complete** enable it when the vault is on (you can still turn it on manually in Local/Minimal).

  | Mode     | credentials.autoCapture.toolCalls |
  |----------|-----------------------------------|
  | Local    | Off (vault off)                   |
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
| credentials (vault) | — | opt | opt | opt |
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
| personaProposals | — | — | ✓ | ✓ |
| personaProposals.autoApply | — | — | — | — |
| memoryTiering | — | ✓ | ✓ | ✓ |
| memoryTiering.compactionOnSessionEnd | — | ✓ | ✓ | ✓ |
| selfCorrection | — | — | ✓ | ✓ |
| selfCorrection.semanticDedup | — | — | ✓ | ✓ |
| selfCorrection.applyToolsByDefault | — | — | ✓ | ✓ |
| autoRecall.entityLookup | — | — | ✓ | ✓ |
| autoRecall.authFailure | — | ✓ | ✓ | ✓ |
| queryExpansion.enabled | — | — | — | ✓ |
| ingest (paths) | — | ✓ | ✓ | ✓ |
| distill.extractDirectives | ✓ | ✓ | ✓ | ✓ |
| distill.extractReinforcement | — | ✓ | ✓ | ✓ |
| distill.extractionModelTier | — | **default (flash)** | default | default |
| errorReporting | — | — | opt | opt |
| **Advanced / opt-in** |
| workflowTracking | — | — | ✓ | ✓ |
| nightlyCycle (dream-cycle) | — | — | ✓ | ✓ |
| passiveObserver | — | — | ✓ | ✓ |
| extraction (multi-pass) | — | — | ✓ | ✓ |
| selfExtension (tool proposals) | — | — | ✓ | ✓ |
| crystallization (skill proposals) | — | — | ✓ | ✓ |
| **Verification / provenance / retrieval** |
| verification | — | — | ✓ | ✓ |
| provenance | — | — | ✓ | ✓ |
| documents | — | — | — | ✓ |
| aliases | — | — | ✓ | ✓ |
| crossAgentLearning | — | — | ✓ | ✓ |
| reranking | — | — | ✓ | ✓ |
| contextualVariants | — | — | ✓ | ✓ |
| **Verbosity level** | quiet | normal | normal | verbose |

**Notes:**

- **opt**: Credentials vault is on only when `credentials.encryptionKey` is set (or env). In Enhanced/Complete, `autoDetect` and `autoCapture.toolCalls` apply when the vault is enabled.
- **personaProposals.autoApply**: Never set by any preset (always **—**). When enabled, approved persona proposals are applied to identity files without human review. **Opt-in only** — no mode turns this on by default.
- **Minimal** uses only nano/flash-tier models for distill, auto-classify, and ingest to keep cost very low. **Local** uses no external LLM (FTS-only recall).
- **Advanced / opt-in** (workflowTracking, nightlyCycle, passiveObserver, extraction, selfExtension, crystallization, verification, provenance, aliases, crossAgentLearning, reranking, contextualVariants) are **off** for Local and Minimal; **Enhanced** and **Complete** enable them by preset. **documents** is Complete-only (requires Python/MarkItDown). Users on Local/Minimal can enable any of these explicitly via config or `openclaw hybrid-mem config-set <key>.enabled true`.
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

---

## See also

- [CONFIGURATION.md](CONFIGURATION.md) — Full config reference.
- [CREDENTIALS.md](CREDENTIALS.md) — Vault setup, migration, and credential capture from tool I/O.
