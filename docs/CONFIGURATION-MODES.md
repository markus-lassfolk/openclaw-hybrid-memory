# Configuration Modes

You can set a **mode** in plugin config to apply a preset of feature toggles. Modes make it easier to choose a safe default and then override only what you need.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "mode": "normal",
          "embedding": { "apiKey": "env:OPENAI_API_KEY", "model": "text-embedding-3-small" }
        }
      }
    }
  }
}
```

Valid values: **`essential`** | **`normal`** | **`expert`** | **`full`**. If you change any feature away from the preset, the effective mode is reported as **Custom** in `openclaw hybrid-mem verify`.

---

## What each mode does

| Mode | Best for | Description |
|------|----------|--------------|
| **Essential** | Raspberry Pi, low-resource hosts, minimal API cost | Only core memory: auto-capture and auto-recall. No classification, no graph, no procedures, no reflection. Credentials vault off. WAL on for safety. Keeps CPU, memory, and LLM calls to a minimum. |
| **Normal** | Most users | Balanced defaults: capture, recall, auto-classify (cheap model), graph and procedures on, reflection off. Credentials vault **off** unless you set an encryption key (opt-in). No credential capture from tool I/O. Good mix of capability and cost. |
| **Expert** | Power users who want most features | Like Normal plus: reflection, persona proposals, memory tiering, self-correction, entity lookup, auth-failure recall. **Credentials vault on** when you set `credentials.encryptionKey` (or env). **Credential capture from tool I/O on** when vault is enabled — scans tool call inputs and stores detected secrets in the vault. Classify-before-write and fuzzy dedupe on. |
| **Full** | Maximum capability, dev or high-resource | Everything enabled: all of Expert plus HyDE search, ingest, distill directives/reinforcement, error reporting if configured. **Credentials vault and credential tool I/O capture on** when vault is enabled. Highest API and compute use. |
| **Custom** | Your own mix | Reported when your config does not match any preset (you changed at least one toggle). No preset is applied; your explicit settings are used. |

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
| memoryTiering | — | ✓ | ✓ | ✓ |
| memoryTiering.compactionOnSessionEnd | — | ✓ | ✓ | ✓ |
| selfCorrection | — | — | ✓ | ✓ |
| selfCorrection.semanticDedup | — | — | ✓ | ✓ |
| selfCorrection.applyToolsByDefault | — | — | ✓ | ✓ |
| autoRecall.entityLookup | — | — | ✓ | ✓ |
| autoRecall.authFailure | — | ✓ | ✓ | ✓ |
| search.hydeEnabled | — | — | — | ✓ |
| ingest (paths) | — | — | — | ✓ |
| distill.extractDirectives | ✓ | ✓ | ✓ | ✓ |
| distill.extractReinforcement | — | ✓ | ✓ | ✓ |
| errorReporting | — | — | opt | opt |

**Notes:**

- **opt**: Credentials vault is on only when `credentials.encryptionKey` is set (or env). In Expert/Full, `autoDetect` and `autoCapture.toolCalls` apply when the vault is enabled.
- **Normal** keeps current product defaults (e.g. graph on, procedures on, reflection off). Essential strips down for low-resource; Expert/Full add reflection, self-correction, and credential capture.

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
