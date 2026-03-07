# Configuration Modes

You can set a **mode** in plugin config to apply a preset of feature toggles. **If you don't set `mode`, the default is `full`** — everything enabled for the best experience. Set `essential` or `normal` only if you want to reduce API cost or run on low-resource hardware.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "mode": "full",
          "embedding": { "apiKey": "env:OPENAI_API_KEY", "model": "text-embedding-3-small" }
        }
      }
    }
  }
}
```

Valid values: **`essential`** | **`normal`** | **`expert`** | **`full`**. Default when omitted: **`full`**. If you change any feature away from the preset, the effective mode is reported as **Custom** in `openclaw hybrid-mem verify`.

---

## What each mode does

| Mode | Best for | Description |
|------|----------|--------------|
| **Full** | **Default — best experience** | Everything enabled: capture, recall, classification, graph, procedures, reflection, tiering, persona proposals, self-correction, query expansion, ingest, dream-cycle, passive observer, workflow tracking, tool/skill proposals. Credentials vault and tool I/O capture on when vault is configured. Highest capability and API use. |
| **Expert** | Like Full with slightly less | Same as Full but no query expansion, no ingest paths, no nightly dream-cycle / passive observer / crystallization / self-extension. Good if you want most features but want to trim a few. |
| **Normal** | Lower cost or simpler setup | Balanced: capture, recall, auto-classify, graph, procedures; no reflection, no persona proposals, no credential capture from tool I/O. Credentials vault off unless you set an encryption key. |
| **Essential** | Raspberry Pi, minimal API cost | Only core memory: auto-capture and auto-recall. No classification, graph, procedures, or reflection. Keeps CPU, memory, and LLM calls to a minimum. |
| **Custom** | Your own mix | Reported when your config does not match any preset (you changed at least one toggle). Your explicit settings are used. |

To reduce API or compute usage, set `"mode": "normal"` or `"mode": "essential"` in your plugin config.

---

## Credentials vault and credential capture

- **Encrypted credentials vault** (`credentials.enabled`): Stores API keys, tokens, passwords in an encrypted SQLite vault instead of in plain facts. Requires `credentials.encryptionKey` (or `env:OPENCLAW_CRED_KEY`).

  | Mode    | Vault default | Note |
  |---------|----------------|------|
  | Essential | Off  | No vault; use env vars for secrets if needed. |
  | Normal  | Off  | Opt-in: set encryption key to enable. |
  | Expert  | On (if key set) | Preset turns vault on when key is present. |
  | Full   | On (if key set) | Same as Expert. |

- **Credentials auto-detect** (`credentials.autoDetect`): Detects credential-like content in conversation and prompts to store in the vault. **Expert / Full** enable this when the vault is on.

- **Credentials capture from tool I/O** (`credentials.autoCapture.toolCalls`): Scans **tool call inputs and outputs** for credential patterns and stores them in the vault. Useful when the agent receives API keys or tokens via tools. **Expert and Full** enable this when the vault is on; **Essential and Normal** leave it off** (you can still turn it on manually).

  | Mode     | credentials.autoCapture.toolCalls |
  |----------|-----------------------------------|
  | Essential | Off (vault off)                   |
  | Normal   | Off                               |
  | Expert   | On (when vault enabled)           |
  | Full    | On (when vault enabled)           |

---

## Feature matrix (on/off by mode)

Below, **✓** = enabled by preset, **—** = disabled by preset, **opt** = optional / depends on other config (e.g. vault only when key set).

| Feature | Essential | Normal | Expert | Full |
|---------|:--------:|:------:|:------:|:----:|
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
| ingest (paths) | — | — | — | ✓ |
| distill.extractDirectives | ✓ | ✓ | ✓ | ✓ |
| distill.extractReinforcement | — | ✓ | ✓ | ✓ |
| errorReporting | — | — | opt | opt |
| **Advanced / opt-in** |
| workflowTracking | — | — | ✓ | ✓ |
| nightlyCycle (dream-cycle) | — | — | ✓ | ✓ |
| passiveObserver | — | — | ✓ | ✓ |
| extraction (multi-pass) | — | — | ✓ | ✓ |
| selfExtension (tool proposals) | — | — | ✓ | ✓ |
| crystallization (skill proposals) | — | — | ✓ | ✓ |

**Notes:**

- **opt**: Credentials vault is on only when `credentials.encryptionKey` is set (or env). In Expert/Full, `autoDetect` and `autoCapture.toolCalls` apply when the vault is enabled.
- **Normal** keeps current product defaults (e.g. graph on, procedures on, reflection off). Essential strips down for low-resource; Expert/Full add reflection, self-correction, and credential capture.
- **Advanced / opt-in** (workflowTracking, nightlyCycle, passiveObserver, extraction, selfExtension, crystallization) are **off** for Essential and Normal; **Expert** and **Full** enable them by preset. Users on Essential/Normal can enable any of these explicitly via config or `openclaw hybrid-mem config-set <key>.enabled true`.
- **personaProposals.autoApply** is `false` in **all** presets including Expert and Full — it is never set automatically. Enable it only if you want the agent to modify identity files (SOUL.md, IDENTITY.md, USER.md) without human review. See [PERSONA-PROPOSALS.md](PERSONA-PROPOSALS.md) for risks and the audit trail.

---

## Overriding the preset

Any key you set in config **overrides** the preset. So you can start from a mode and tweak:

```json
{
  "config": {
    "mode": "normal",
    "embedding": { "apiKey": "env:OPENAI_API_KEY", "model": "text-embedding-3-small" },
    "reflection": { "enabled": true }
  }
}
```

Here you get Normal preset but with reflection enabled. Verify will report **Mode: Custom** because the resolved config no longer matches the Normal preset.

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
