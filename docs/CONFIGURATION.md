---
layout: default
title: Configuration
parent: Getting Started
nav_order: 3
---
# Configuration Reference

All settings live in `~/.openclaw/openclaw.json`. Merge these into your existing config. Replace placeholders; do **not** commit real API keys to git.

**Quick setup:** Run `openclaw hybrid-mem install` to apply all recommended defaults at once. Then customise as needed below.

**Configuration modes:** You can set `"mode": "essential" | "normal" | "expert" | "full"` to apply a preset of feature toggles (e.g. **Essential** for Raspberry Pi, **Normal** for most users, **Expert**/**Full** for power users). See [CONFIGURATION-MODES.md](CONFIGURATION-MODES.md) for the matrix and where credentials vault and credential capture from tool I/O fit in.

---

## Memory slot and memory-hybrid plugin

OpenClaw allows only one plugin to own the `memory` slot. Set it to **openclaw-hybrid-memory**:

```json
{
  "plugins": {
    "slots": {
      "memory": "openclaw-hybrid-memory"
    },
    "entries": {
      "memory-core": {
        "enabled": true
      },
      "openclaw-hybrid-memory": {
        "enabled": true,
        "config": {
          "embedding": {
            "apiKey": "YOUR_OPENAI_API_KEY",
            "model": "text-embedding-3-small"
          },
          "autoCapture": true,
          "autoRecall": true,
          "captureMaxChars": 5000
        }
      }
    }
  }
}
```

**memory-core** stays `enabled: true` alongside memory-hybrid: it provides file-based tools independently of the slot.

**API key:** Inline the key if non-interactive shells don't load your env. Editing the config file directly is more reliable than using `config.patch`.

**Embedding model preference:** Optional `embedding.models` is an ordered list of embedding model names (e.g. `["text-embedding-3-small"]`). The plugin tries the first; on failure (rate limit, provider down) it tries the next. All entries must have the **same vector dimension** (1536 for `text-embedding-3-small`, 3072 for `text-embedding-3-large`). The first model in the list defines the dimension used for LanceDB. See [LLM-AND-PROVIDERS.md](LLM-AND-PROVIDERS.md#embedding-configuration).

Optional: `lanceDbPath` and `sqlitePath` (defaults: `~/.openclaw/memory/lancedb` and `~/.openclaw/memory/facts.db`).

---

## Auto-capture and auto-recall

`captureMaxChars` (default 5000): messages longer than this are not captured; stored text is truncated to this length.

`store.fuzzyDedupe` (default `false`): enables fuzzy deduplication — before storing, normalizes text, hashes it, skips if an existing fact has the same hash.

**Memory operation classification (Mem0-style):**

| Key | Default | Description |
|-----|--------|-------------|
| `store.classifyBeforeWrite` | `false` | When `true`, classify each new fact against similar existing facts (by embedding + entity/key) as ADD, UPDATE, DELETE, or NOOP before storing. Reduces duplicates and stale contradictions. Applies to auto-capture, `memory_store` tool, CLI `hybrid-mem store`, and `extract-daily`. |
| `store.classifyModel` | `gpt-4o-mini` | Chat model used for the classification call (low cost). |

Example: `"store": { "fuzzyDedupe": false, "classifyBeforeWrite": true, "classifyModel": "gpt-4o-mini" }`

### Auto-recall options

`autoRecall` can be `true` (defaults) or an object:

```json
{
  "autoRecall": {
    "enabled": true,
    "maxTokens": 800,
    "maxPerMemoryChars": 0,
    "injectionFormat": "full",
    "limit": 10,
    "minScore": 0.3,
    "preferLongTerm": false,
    "useImportanceRecency": false,
    "entityLookup": {
      "enabled": false,
      "entities": ["user", "owner"],
      "maxFactsPerEntity": 2
    },
    "summaryThreshold": 300,
    "summaryMaxChars": 80,
    "useSummaryInInjection": true,
    "summarizeWhenOverBudget": false,
    "summarizeModel": "gpt-4o-mini",
    "progressiveMaxCandidates": 15,
    "progressiveIndexMaxTokens": 300,
    "progressiveGroupByCategory": false,
    "progressivePinnedRecallCount": 3
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `maxTokens` | `800` | Total tokens injected per turn |
| `maxPerMemoryChars` | `0` | Truncate each memory to N chars (0 = no truncation) |
| `injectionFormat` | `"full"` | `full` = `[backend/category] text`, `short` = `category: text`, `minimal` = text only, `progressive` = memory index (agent fetches via `memory_recall`), `progressive_hybrid` = pinned in full + rest as index |
| `limit` | `10` | Max memories considered for injection |
| `minScore` | `0.3` | Minimum vector search score (0–1) |
| `preferLongTerm` | `false` | Boost permanent (×1.2) and stable (×1.1) facts |
| `useImportanceRecency` | `false` | Combine relevance with importance and recency |
| `entityLookup.enabled` | `false` | Merge entity lookup facts when prompt mentions an entity |
| `summaryThreshold` | `300` | Facts longer than this get a stored summary |
| `summaryMaxChars` | `80` | Max chars for the summary |
| `useSummaryInInjection` | `true` | Use summary in injection to save tokens |
| `summarizeWhenOverBudget` | `false` | When token cap forces dropping memories, LLM-summarize all into 2-3 sentences |
| `summarizeModel` | `gpt-4o-mini` | Model for summarize-when-over-budget |
| `progressiveMaxCandidates` | `15` | Max memories in progressive index; used when `injectionFormat` is `progressive` or `progressive_hybrid` |
| `progressiveIndexMaxTokens` | `300` when progressive | Token cap for the index block in progressive mode |
| `progressiveGroupByCategory` | `false` | Group index lines by category for readability |
| `progressivePinnedRecallCount` | `3` | In `progressive_hybrid`: facts with recallCount ≥ this or permanent decay are injected in full |
| `scopeFilter` | (none) | Multi-user: restrict auto-recall to global + matching scopes. `{ "userId": "alice", "agentId": "support-bot", "sessionId": "sess-xyz" }` — omit any to not filter by that dimension. See [MEMORY-SCOPING.md](MEMORY-SCOPING.md). |

---

## Memory tiering (hot/warm/cold)

Dynamic tiering keeps a small **HOT** set always loaded, uses **WARM** for semantic search, and archives **COLD** for manual or deep retrieval only. Compaction runs on session end (or via `hybrid-mem compact`).

```json
{
  "memoryTiering": {
    "enabled": true,
    "hotMaxTokens": 2000,
    "compactionOnSessionEnd": true,
    "inactivePreferenceDays": 7,
    "hotMaxFacts": 50
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Enable HOT/WARM/COLD tiers and compaction |
| `hotMaxTokens` | `2000` | Max tokens for HOT tier always injected at session start (&lt;2k per issue) |
| `compactionOnSessionEnd` | `true` | Run compaction automatically when the agent session ends |
| `inactivePreferenceDays` | `7` | Preferences not accessed in this many days (and currently HOT) are moved to WARM |
| `hotMaxFacts` | `50` | Max facts allowed in HOT when promoting blockers |

**Compaction rules:** Completed tasks (category `decision` or tag `task`) → COLD. Inactive preferences (in HOT, not accessed recently) → WARM. Active blockers (tag `blocker`) → HOT, capped by `hotMaxTokens` and `hotMaxFacts`.

→ Full detail: [MEMORY-TIERING.md](MEMORY-TIERING.md)

---

## Multilingual language keywords

Auto-capture, category detection, and decay classification use keyword/phrase patterns. By default only English is in code; other languages are loaded from a generated file (`.language-keywords.json`). You can have the plugin **build that file automatically** so conversations in other languages (e.g. Swedish, German) are captured and classified correctly.

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
| `autoBuild` | `true` | Run language detection + keyword generation once at startup if no file exists, then on a weekly (or configured) interval. Set to `false` to disable automatic build; you can still run `openclaw hybrid-mem build-languages` manually. |
| `weeklyIntervalDays` | `7` | Days between automatic builds (1–30). |

When `autoBuild` is `true`, the plugin samples recent facts, detects the top languages, calls the LLM to generate intent-based keyword equivalents, and writes `~/.openclaw/memory/.language-keywords.json` (or next to your `sqlitePath`). New and upgraded setups get this **enabled by default** via `openclaw hybrid-mem install`.

→ Full detail: [LANGUAGE-KEYWORDS.md](LANGUAGE-KEYWORDS.md)

---

## memorySearch (semantic file search)

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "enabled": true,
        "sources": ["memory"],
        "provider": "openai",
        "model": "text-embedding-3-small",
        "sync": {
          "onSessionStart": true,
          "onSearch": true,
          "watch": true
        },
        "chunking": {
          "tokens": 500,
          "overlap": 50
        },
        "query": {
          "maxResults": 8,
          "minScore": 0.3,
          "hybrid": { "enabled": true }
        }
      }
    }
  }
}
```

---

## Memory backend

```json
{
  "memory": {
    "backend": "builtin",
    "citations": "auto"
  }
}
```

---

## Compaction memory flush (recommended)

When a session nears auto-compaction, the model gets a chance to save important information. Custom prompts make it use **both** memory systems:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "mode": "default",
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 4000,
          "systemPrompt": "Session nearing compaction. You MUST save all important context NOW using BOTH memory systems before it is lost. This is your last chance to preserve this information.",
          "prompt": "URGENT: Context is about to be compacted. Scan the full conversation and:\n1. Use memory_store for each important fact, preference, decision, or entity (structured storage survives compaction)\n2. Write a session summary to memory/YYYY-MM-DD.md with key topics, decisions, and open items\n3. Update any relevant memory/ files if project state or technical details changed\n\nDo NOT skip this. Reply NO_REPLY only if there is truly nothing worth saving."
        }
      }
    }
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `false` | Enable the pre-compaction memory flush turn |
| `softThresholdTokens` | `4000` | Flush triggers when tokens cross `contextWindow - reserveTokensFloor - softThresholdTokens` |
| `systemPrompt` | (generic) | System prompt appended to the flush turn |
| `prompt` | (generic) | User prompt for the flush turn |

---

## Bootstrap limits (recommended)

```json
{
  "agents": {
    "defaults": {
      "bootstrapMaxChars": 15000,
      "bootstrapTotalMaxChars": 50000
    }
  }
}
```

**Context window:** OpenClaw auto-detects the model's context window. Only set `contextTokens` manually if you hit prompt-overflow errors.

---

## Pruning (optional)

```json
{
  "agents": {
    "defaults": {
      "pruning": {
        "ttl": "30m"
      }
    }
  }
}
```

Prunes stale tool results from context. Add if you see prompts growing too large.

---

## Auto-classify

See [FEATURES.md](FEATURES.md) for how auto-classify works. Configuration:

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "autoClassify": {
            "enabled": true,
            "model": "gpt-4o-mini",
            "batchSize": 20
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable background auto-classify on startup + every 24h |
| `model` | `"gpt-4o-mini"` | Any chat model your API key supports |
| `batchSize` | `20` | Facts per LLM call |

---

## Reflection (pattern synthesis)

Pattern synthesis from session history. See [REFLECTION.md](REFLECTION.md) for full documentation.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "reflection": {
            "enabled": false,
            "model": "gpt-4o-mini",
            "defaultWindow": 14,
            "minObservations": 2
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable reflection layer (CLI and memory_reflect tool) |
| `model` | `"gpt-4o-mini"` | LLM for reflection analysis |
| `defaultWindow` | `14` | Time window in days for fact gathering |
| `minObservations` | `2` | Minimum observations to support a pattern |

---

## LLM routing and model preference

All chat/completion calls (distillation, reflection, classify, consolidate, proposals, self-correction, ingest, HyDE, build-languages) go through the **OpenClaw gateway** (OpenAI-compatible API). You can use any provider the gateway supports. Optional **`llm`** config defines ordered model lists per tier and fallback behaviour.

**Recommended:** set `llm` so the plugin tries your preferred models in order and falls back if one fails (e.g. no key, rate limit, outage). See [LLM-AND-PROVIDERS.md](LLM-AND-PROVIDERS.md) for prerequisites and how each feature uses LLMs.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "llm": {
            "default": ["gemini-2.0-flash", "claude-sonnet-4", "gpt-4o-mini"],
            "heavy": ["gemini-2.0-flash-thinking", "claude-opus-4", "gpt-4o"],
            "fallbackToDefault": true,
            "fallbackModel": "gpt-4o-mini"
          }
        }
      }
    }
  }
}
```

| Key | Description |
|-----|-------------|
| `default` | Ordered list of models for default-tier features (reflection, classify, consolidate, ingest, HyDE, build-languages). First working model wins. Use **exact IDs** your gateway accepts (run `openclaw models list` or `openclaw models list --all`). |
| `heavy` | Ordered list for heavy-tier features (distillation, persona proposals, self-correction spawn). Same ID rules as `default`. |
| `fallbackToDefault` | If `true`, after all list models fail, try one more fallback model. |
| `fallbackModel` | Optional. When `fallbackToDefault` is true and this key is set, use this model as the last try (only added if not already in the `default`/`heavy` list); if omitted, no extra fallback beyond the tier list is applied. |

When `llm` is set, maintenance jobs and CLI commands use these lists. When `llm` is **not** set, the plugin uses **legacy** provider-based selection (see below).

---

## Session distillation (legacy: `distill`)

Session distillation uses an LLM to extract durable facts from conversation logs. Prefer configuring models via **`llm`** (above); the **`distill`** block is optional and deprecated in favour of gateway + `llm`.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "distill": {
            "apiKey": "YOUR_GOOGLE_API_KEY",
            "defaultModel": "gemini-2.0-flash"
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `apiKey` | (none) | Legacy: raw Google API key or `env:VAR_NAME`. When using OpenClaw gateway routing, the plugin does not need a Google/Gemini API key here; the gateway handles provider keys. Prefer gateway + `llm.heavy`. |
| `defaultModel` | — | Model used when `openclaw hybrid-mem distill` is run without `--model` and `llm` is not set. |

**Batch size:** Long-context models (model name containing `gemini`) use larger batches (500k tokens); others default to 80k. See [SESSION-DISTILLATION.md](SESSION-DISTILLATION.md) for details.

---

## Default model selection (when `llm` is not set)

When **`llm`** is **not** configured, the plugin builds an **ordered list** from providers that have API keys, in preferred order: **Gemini → OpenAI → Claude**. The first working model wins; if one fails (e.g. rate limit, disallowed by gateway), the next in the list is tried.

| Order | Provider | Condition | Default-tier model | Heavy-tier model |
|-------|----------|-----------|---------------------|------------------|
| 1 | **Gemini** | `distill.apiKey` set | `distill.defaultModel` or `gemini-2.0-flash` | same or `gemini-2.0-flash-thinking-exp-01-21` |
| 2 | **OpenAI** | `embedding.apiKey` set | `gpt-4o-mini` | `gpt-4o` |
| 3 | **Claude** | `claude.apiKey` set | `claude.defaultModel` or Claude Sonnet | Claude Opus |

Optional **`distill.fallbackModels`** (deprecated) and **`llm.fallbackModel`** (when set) are appended to this list so they are tried after the provider order. Run **`openclaw hybrid-mem verify`** to see the effective order for default and heavy tier and which providers have keys. Use **`openclaw hybrid-mem verify --test-llm`** to run a minimal completion against each configured model and report success or failure (requires the gateway to be running). If a model fails or is disallowed by the gateway, allow it in your OpenClaw gateway config or remove it from the list (by setting **`llm.default`** / **`llm.heavy`** explicitly).

When you run **`openclaw hybrid-mem verify --fix`**, the plugin writes each optional job with a concrete `model` value resolved from this logic (existing jobs are not overwritten). **Self-correction:** Leave `selfCorrection.spawnModel` empty to use the same default; set it to a model string to override.

---

## Multi-language keywords

The plugin supports multiple languages for **trigger detection** (should we capture?), **category detection**, and **decay classification**. English is built-in; other languages are added via a generated file `.language-keywords.json` (next to `facts.db`). You can let the plugin build it automatically or run `openclaw hybrid-mem build-languages` manually.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "languageKeywords": {
            "autoBuild": true,
            "weeklyIntervalDays": 7
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `autoBuild` | `true` | If true: build `.language-keywords.json` once at startup when missing (after 3s), then every `weeklyIntervalDays` days. Uses fact samples + LLM to detect top 3 languages and generate intent-based keywords. |
| `weeklyIntervalDays` | `7` | Interval in days for automatic language keyword rebuild (capped at 30). |

Set `autoBuild` to `false` to disable automatic builds; run `openclaw hybrid-mem build-languages` manually when you want to update languages.

→ Full docs: [MULTILINGUAL-SUPPORT.md](MULTILINGUAL-SUPPORT.md)

---

## Ingest workspace files (issue #33)

Index workspace markdown (skills, TOOLS.md, AGENTS.md) as facts. See [SEARCH-RRF-INGEST.md](SEARCH-RRF-INGEST.md) for full docs.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "ingest": {
            "paths": ["skills/**/*.md", "TOOLS.md", "AGENTS.md"],
            "chunkSize": 800,
            "overlap": 100
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `paths` | — | Glob patterns relative to workspace; required |
| `chunkSize` | 800 | Chars per chunk for LLM extraction |
| `overlap` | 100 | Overlap between chunks |

---

## Search (HyDE query expansion, issue #33)

Opt-in HyDE generates a hypothetical answer before embedding for vector search. See [SEARCH-RRF-INGEST.md](SEARCH-RRF-INGEST.md).

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "search": {
            "hydeEnabled": false,
            "hydeModel": "gpt-4o-mini"
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `hydeEnabled` | `false` | Generate hypothetical answer before embedding |
| `hydeModel` | (unset) | Model for HyDE generation; when omitted, uses first model from `llm.default` or legacy default (issue #92) |

---

## Self-correction analysis (issue #34)

Optional config for the self-correction pipeline: semantic dedup before storing facts, TOOLS.md section name, auto-rewrite vs suggest-and-approve, and Phase 2 via spawn for large batches. See [SELF-CORRECTION-PIPELINE.md](SELF-CORRECTION-PIPELINE.md).

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "selfCorrection": {
            "semanticDedup": true,
            "semanticDedupThreshold": 0.92,
            "toolsSection": "Self-correction rules",
            "applyToolsByDefault": true,
            "autoRewriteTools": false,
            "analyzeViaSpawn": false,
            "spawnThreshold": 15,
            "spawnModel": "gemini"
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `semanticDedup` | `true` | Skip storing facts that are semantically similar to existing ones |
| `semanticDedupThreshold` | `0.92` | Similarity threshold 0–1 for semantic dedup |
| `toolsSection` | `"Self-correction rules"` | TOOLS.md section heading for inserted rules |
| `applyToolsByDefault` | `true` | When true, apply TOOLS rules by default; set false to only suggest (use `--approve` or `--no-apply-tools`) |
| `autoRewriteTools` | `false` | When true, LLM rewrites TOOLS.md to integrate new rules; when false, use section insert |
| `analyzeViaSpawn` | `false` | When true and incidents > spawnThreshold, run Phase 2 via `openclaw sessions spawn` |
| `spawnThreshold` | `15` | Use spawn for Phase 2 when incident count exceeds this |
| `spawnModel` | `gemini` | Model for spawn when analyzeViaSpawn is true |

---

## Custom categories

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "categories": ["research", "health", "finance"]
        }
      }
    }
  }
}
```

The seven defaults (`preference`, `fact`, `decision`, `entity`, `pattern`, `rule`, `other`) are always included. See [FEATURES.md](FEATURES.md) for details on categories and discovery.

---

## Version metadata

| Source | Meaning |
|--------|---------|
| **pluginVersion** | Release version (from `package.json`) |
| **memoryManagerVersion** | Spec version aligned with this system (e.g. `3.0`) |
| **schemaVersion** | DB schema version; bump on migrations |

At runtime: `openclaw hybrid-mem stats` shows versions.

---

## Related docs

- [QUICKSTART.md](QUICKSTART.md) — Installation and first run
- [FEATURES.md](FEATURES.md) — Categories, decay, tags, auto-classify
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — All CLI commands
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — Common issues and fixes
- [CREDENTIALS.md](CREDENTIALS.md) — Credentials vault configuration
- [REFLECTION.md](REFLECTION.md) — Reflection layer configuration
- [GRAPH-MEMORY.md](GRAPH-MEMORY.md) — Graph memory configuration
