---
layout: default
title: Configuration
parent: Getting Started
nav_order: 3
---
# Configuration Reference

All settings live in `~/.openclaw/openclaw.json`. Merge these into your existing config. Replace placeholders; do **not** commit real API keys to git.

**Quick setup:** Run `openclaw hybrid-mem install` to apply all recommended defaults at once. Then customise as needed below.

**Configuration modes:** Default is **Full** (best experience). You can set `"mode": "essential" | "normal" | "expert" | "full"` to apply a preset (e.g. **Essential** or **Normal** to reduce API cost or for low-resource hosts). See [CONFIGURATION-MODES.md](CONFIGURATION-MODES.md) for the matrix.

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
            "provider": "openai",
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

**Embedding provider:** Set `embedding.provider` to choose your embedding backend. Options: `"openai"` (default, requires API key), `"ollama"` (local, no key), `"onnx"` (local, no key, requires `onnxruntime-node`), `"google"` (Gemini API, requires `llm.providers.google.apiKey`). Use `embedding.preferredProviders` for ordered failover (e.g. `["ollama", "openai"]`). See [LLM-AND-PROVIDERS.md](LLM-AND-PROVIDERS.md#embedding-providers) for full examples.

**Embedding model preference:** Optional `embedding.models` is an ordered list of embedding model names (e.g. `["text-embedding-3-small"]`). The plugin tries the first; on failure (rate limit, provider down) it tries the next. All entries must have the **same vector dimension** (1536 for `text-embedding-3-small`, 3072 for `text-embedding-3-large`). The first model in the list defines the dimension used for LanceDB. See [LLM-AND-PROVIDERS.md](LLM-AND-PROVIDERS.md#embedding-providers).

Optional: `lanceDbPath` and `sqlitePath` (defaults: `~/.openclaw/memory/lancedb` and `~/.openclaw/memory/facts.db`).

---

## Verbosity level (silent mode)

The plugin supports four verbosity levels for CLI commands and tool output, configured via `verbosity`.

```json
{
  "verbosity": "silent"
}
```

- **`silent`**: Suppresses all unsolicited context blocks injected into prompts (e.g. capability hints, `<relevant-memories>`, `<relevant-procedures>`, and credential-hint blocks). Memory tools (`memory_store`, `memory_recall`, etc.) remain fully functional. Ideal for users who want the plugin to work entirely in the background without cluttering the context window.
- **`quiet`**: Minimal output. For CLI commands, shows only counts/totals without decorative headers. (Default for `essential` mode).
- **`normal`**: Balanced output with key details. (Default for `normal` and `expert` modes).
- **`verbose`**: Extra detail. Full breakdowns, all fields, and config summaries. Ideal for debugging. (Default for `full` mode).

You can change this on the fly using the CLI:

```bash
openclaw hybrid-mem config set verbosity silent
```


## Auto-capture and auto-recall

`captureMaxChars` (default 5000): messages longer than this are not captured; stored text is truncated to this length.

`store.fuzzyDedupe` (default `false`): enables fuzzy deduplication — before storing, normalizes text, hashes it, skips if an existing fact has the same hash.

**Memory operation classification (Mem0-style):**

| Key | Default | Description |
|-----|--------|-------------|
| `store.classifyBeforeWrite` | `false` | When `true`, classify each new fact against similar existing facts (by embedding + entity/key) as ADD, UPDATE, DELETE, or NOOP before storing. Reduces duplicates and stale contradictions. Applies to auto-capture, `memory_store` tool, CLI `hybrid-mem store`, and `extract-daily`. |
| `store.classifyModel` | `llm.nano[0]` (e.g. `openai/gpt-4.1-nano`) | Chat model used for the classification call (low cost). |

Example: `"store": { "fuzzyDedupe": false, "classifyBeforeWrite": true, "classifyModel": "openai/gpt-4.1-nano" }`

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
    "summarizeModel": "openai/gpt-4.1-nano",
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
| `summarizeModel` | `llm.nano[0]` (e.g. `openai/gpt-4.1-nano`) | Model for summarize-when-over-budget |
| `progressiveMaxCandidates` | `15` | Max memories in progressive index; used when `injectionFormat` is `progressive` or `progressive_hybrid` |
| `progressiveIndexMaxTokens` | `300` when progressive | Token cap for the index block in progressive mode |
| `progressiveGroupByCategory` | `false` | Group index lines by category for readability |
| `progressivePinnedRecallCount` | `3` | In `progressive_hybrid`: facts with recallCount ≥ this or permanent decay are injected in full |
| `scopeFilter` | (none) | Multi-user: restrict auto-recall to global + matching scopes. `{ "userId": "alice", "agentId": "support-bot", "sessionId": "sess-xyz" }` — omit any to not filter by that dimension. See [MEMORY-SCOPING.md](MEMORY-SCOPING.md). |

### Retrieval directives

Besides semantic auto-recall, you can trigger **targeted recall** by entity mention, keywords, task types, or once at session start. When the prompt matches, directive recall runs and results are merged into the injection pipeline. Agent-scoped memory and scope filtering apply so specialists see only relevant scoped facts.

```json
{
  "autoRecall": {
    "enabled": true,
    "retrievalDirectives": {
      "enabled": true,
      "entityMentioned": true,
      "keywords": ["oncall", "incident"],
      "taskTypes": {
        "debug": ["bug", "fix", "crash"],
        "research": ["summarize", "find papers"]
      },
      "sessionStart": false,
      "limit": 3,
      "maxPerPrompt": 4
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` when `autoRecall` is object | Enable retrieval directives (entity/keyword/task-type/session-start) |
| `entityMentioned` | `true` | When the prompt mentions an entity from entity lookup list, run targeted recall for that entity |
| `keywords` | `[]` | Case-insensitive keyword triggers; when prompt contains one, run targeted recall |
| `taskTypes` | `{}` | Map task type → keyword list; matched task type triggers recall with those keywords |
| `sessionStart` | `false` | Run a one-time targeted recall when a new session starts |
| `limit` | `3` | Max results per directive recall |
| `maxPerPrompt` | `4` | Hard cap on directive recalls per prompt (limits latency) |

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

## Multi-agent scoping

Facts can be stored and recalled by scope: global, user, agent, or session. With **multi-agent** config, the orchestrator can store globally while specialists store per-agent; auto-recall filters by scope so each agent sees only relevant memories. See [MEMORY-SCOPING.md](MEMORY-SCOPING.md) for full detail.

```json
{
  "multiAgent": {
    "orchestratorId": "main",
    "defaultStoreScope": "auto"
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `orchestratorId` | `"main"` | Agent ID of the main orchestrator (sees all memories; no scope filter) |
| `defaultStoreScope` | `"global"` | `global` = all store global; `agent` = all store agent-scoped; `auto` = orchestrator stores global, specialists store agent-scoped |

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
          "flushEveryCompaction": true,
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
            "model": "openai/gpt-4.1-nano",
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
| `model` | `"openai/gpt-4.1-nano"` | Any chat model your API key supports |
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
            "model": "openai/gpt-4.1-nano",
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
| `model` | `"openai/gpt-4.1-nano"` | LLM for reflection analysis |
| `defaultWindow` | `14` | Time window in days for fact gathering |
| `minObservations` | `2` | Minimum observations to support a pattern |

---

## Memory-to-skills (issue #114)

Cluster procedural memories and synthesize SKILL.md drafts into `skills/auto-generated/`. See [MEMORY-TO-SKILLS.md](MEMORY-TO-SKILLS.md) for full documentation.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "memoryToSkills": {
            "enabled": true,
            "schedule": "15 2 * * *",
            "windowDays": 30,
            "minInstances": 3,
            "consistencyThreshold": 0.7,
            "outputDir": "skills/auto-generated",
            "notify": true,
            "autoPublish": false
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | same as procedures | Enable memory-to-skills pipeline |
| `schedule` | `"15 2 * * *"` | Cron for nightly run (2:15 AM, staggered after nightly-distill) |
| `windowDays` | `30` | Procedures updated in last N days |
| `minInstances` | `3` | Minimum procedure instances per cluster |
| `consistencyThreshold` | `0.7` | Step consistency 0–1 required |
| `outputDir` | `"skills/auto-generated"` | Output path relative to workspace |
| `notify` | `true` | Intended hint that the agent should notify on new drafts; currently informational only (nightly cron/publish flow does not yet consult this). |
| `autoPublish` | `false` | Intended toggle for auto-publishing vs. always requiring human review; currently informational only (nightly cron/publish flow does not yet consult this). |
| `validateScript` | — | Optional path to post-generation validation script (e.g. quick_validate.py). Not invoked by the plugin; for documentation/workflow only. |

When you run `install` or `verify --fix`, the **nightly-memory-to-skills** cron job is added or updated; its schedule is taken from `memoryToSkills.schedule` when available.

---

## LLM model tiers and provider config

The plugin makes **direct API calls** to provider endpoints — it does not route through the OpenClaw gateway agent pipeline. Use the **`llm`** block to configure ordered model lists per tier and per-provider API keys.

See [LLM-AND-PROVIDERS.md](LLM-AND-PROVIDERS.md) for the full reference, provider-specific details (Anthropic headers, o-series quirks), and the recommended model matrix.

**Three tiers:**

| Tier | Used for | Recommended models |
|------|----------|--------------------|
| `nano` | autoClassify, query expansion, classifyBeforeWrite, auto-recall summarize (runs every message) | `gemini-2.5-flash-lite`, `gpt-4.1-nano`, `claude-haiku-4-5` |
| `default` | reflection, language keywords, general analysis | `gemini-2.5-flash`, `claude-sonnet-4-6`, `gpt-4.1` |
| `heavy` | distillation, self-correction, persona proposals | `gemini-3.1-pro-preview`, `claude-opus-4-6`, `o3` |

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "llm": {
            "nano":    ["google/gemini-2.5-flash-lite",    "openai/gpt-4.1-nano",         "anthropic/claude-haiku-4-5"],
            "default": ["google/gemini-2.5-flash",          "anthropic/claude-sonnet-4-6", "openai/gpt-4.1"],
            "heavy":   ["google/gemini-3.1-pro-preview",    "anthropic/claude-opus-4-6",   "openai/o3"],
            "providers": {
              "anthropic": { "apiKey": "sk-ant-..." }
            }
          }
        }
      }
    }
  }
}
```

| Key | Description |
|-----|-------------|
| `nano` | Ordered list for ultra-cheap nano-tier ops. Falls back to `default[0]` when unset. |
| `default` | Ordered list for default-tier features (reflection, classify, ingest, query expansion, build-languages). First working model wins. |
| `heavy` | Ordered list for heavy-tier features (distillation, persona proposals, self-correction). |
| `providers` | Per-provider API keys and optional `baseURL`. Built-in (no `baseURL` needed): `google` (uses `distill.apiKey` fallback), `openai` (uses `embedding.apiKey` fallback), `anthropic` (requires explicit key), `minimax` (uses `MINIMAX_API_KEY` env var fallback). Any other OpenAI-compatible provider can be added here with an explicit `baseURL`. |
| `fallbackToDefault` | If `true`, after all list models fail, try one more fallback model. |
| `fallbackModel` | Optional last-resort model when `fallbackToDefault` is true. |

**Zero config:** When `llm` is not set, the plugin automatically derives tiers from `agents.defaults.model` (the list shown by `openclaw models list`). The verify output shows `(auto from agents.defaults.model)` when this is active.

Run **`openclaw hybrid-mem verify`** to see effective models per tier and feature. Run **`openclaw hybrid-mem verify --test-llm`** to confirm each configured model is reachable.

---

## Session distillation (legacy: `distill`)

Session distillation uses an LLM to extract durable facts from conversation logs. Prefer configuring models via **`llm.heavy`** (above); the **`distill`** block is legacy.

```json
"distill": {
  "apiKey": "AIzaSy...",
  "defaultModel": "google/gemini-3.1-pro-preview"
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `apiKey` | (none) | Legacy Google API key. Still used as a fallback key for `google/*` models when `llm.providers.google.apiKey` is not set. |
| `defaultModel` | — | Model used when `openclaw hybrid-mem distill --model` is not specified and `llm` is not set. |

**Batch size:** Long-context models (model name containing `gemini`) use larger batches (500k tokens); others default to 80k. See [SESSION-DISTILLATION.md](SESSION-DISTILLATION.md) for details.

---

## Default model selection (when `llm` is not set)

When **`llm`** is **not** configured *and* `agents.defaults.model` is also empty, the plugin falls back to legacy key-based detection:

| Order | Provider | Condition | Default-tier model | Heavy-tier model |
|-------|----------|-----------|---------------------|------------------|
| 1 | **Gemini** | `distill.apiKey` set | `distill.defaultModel` or `google/gemini-2.5-flash` | `google/gemini-3.1-pro-preview` |
| 2 | **OpenAI** | `embedding.apiKey` set | `openai/gpt-4.1-mini` | `openai/gpt-5.4` |
| 3 | **Claude** | `claude.apiKey` set | `claude.defaultModel` or `anthropic/claude-sonnet-4-6` | `anthropic/claude-opus-4-6` |

In practice, the auto-derive from `agents.defaults.model` almost always applies first. **Self-correction:** Leave `selfCorrection.spawnModel` empty to use the heavy-tier default; set it to a specific model to override.

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

## Query expansion (queryExpansion)

Opt-in **query expansion** generates a hypothetical answer (or expanded query) before embedding for vector search, improving recall. Replaces the deprecated **search.hydeEnabled** / **search.hydeModel** (see migration below). See [SEARCH-RRF-INGEST.md](SEARCH-RRF-INGEST.md).

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "queryExpansion": {
            "enabled": true,
            "model": "google/gemini-2.5-flash-lite",
            "timeoutMs": 5000
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable query expansion before embedding (uses nano-tier model when `model` unset) |
| `model` | (nano tier) | Model for expansion; when omitted, uses first model from `llm.nano` |
| `timeoutMs` | `5000` (25s when migrating from HyDE) | Timeout for expansion call in ms |
| `maxVariants` | `4` | Max query variants to generate and merge |
| `cacheSize` | `100` | Cache size for expansion results |

**Migration from HyDE:** If you still have `search.hydeEnabled: true`, the plugin auto-enables `queryExpansion` and uses `search.hydeModel` (or nano tier) for the model. You will see a deprecation warning in the logs. Set `queryExpansion.enabled` and `queryExpansion.model` in config and remove `search.hydeEnabled` / `search.hydeModel` to silence it. Explicit `queryExpansion.enabled: false` overrides the old flag.

**Deprecated (do not use in new config):** `search.hydeEnabled`, `search.hydeModel` — use `queryExpansion.enabled` and `queryExpansion.model` instead.

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

## Workflow crystallization

Workflow crystallization analyses tool-sequence patterns and generates pending **AgentSkill SKILL.md** proposals. No skills are written until a human approves via `memory_crystallize_approve` or the CLI. Requires the workflow store (tool-sequence tracking). See release notes 2026.3.70 and [CLI-REFERENCE.md](CLI-REFERENCE.md).

```json
{
  "crystallization": {
    "enabled": false,
    "minUsageCount": 5,
    "minSuccessRate": 0.7,
    "autoApprove": false,
    "outputDir": "~/.openclaw/workspace/skills/auto",
    "maxCrystallized": 50,
    "pruneUnusedDays": 30
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable crystallization (skill proposals from workflow patterns) |
| `minUsageCount` | `5` | Minimum uses of a pattern to be a crystallization candidate |
| `minSuccessRate` | `0.7` | Minimum success rate (0–1) for a pattern |
| `autoApprove` | `false` | If true, approved proposals write to disk without manual approve (not recommended) |
| `outputDir` | `~/.openclaw/workspace/skills/auto` | Directory for approved SKILL.md files |
| `maxCrystallized` | `50` | Max number of crystallized skills to keep |
| `pruneUnusedDays` | `30` | Prune proposals unused for this many days |

**Agent tools:** `memory_crystallize`, `memory_crystallize_list`, `memory_crystallize_approve`, `memory_crystallize_reject`.

---

## Self-extension / tool proposals

Self-extension analyses workflow traces for recurring multi-step workarounds and generates **tool proposals** (specifications for a human or LLM to implement). Requires `selfExtension.enabled: true` and workflow tracking. See release notes 2026.3.70.

```json
{
  "selfExtension": {
    "enabled": false,
    "minGapFrequency": 3,
    "minToolSavings": 2,
    "maxProposals": 20
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable tool proposal generation from usage-pattern gaps |
| `minGapFrequency` | `3` | Minimum occurrences of a gap pattern to propose a tool |
| `minToolSavings` | `2` | Minimum tool calls the proposed tool would save per use |
| `maxProposals` | `20` | Maximum number of proposals to keep |

**Agent tools:** `memory_propose_tool`, `memory_tool_proposals`, `memory_tool_approve`, `memory_tool_reject`.

---

## Future-date decay protection (#144)

When a fact mentions a future date (e.g. "Meeting on 2027-06-15"), the plugin automatically **freezes decay** for that fact until the date passes. This prevents time-sensitive reminders from silently expiring before they are relevant.

Enabled by default; no config required. Tune or disable with `futureDateProtection`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "futureDateProtection": {
            "enabled": true,
            "maxFreezeDays": 365
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Freeze decay on facts that contain a future date |
| `maxFreezeDays` | `365` | Maximum days to freeze decay ahead. `0` = no limit. Prevents facts with dates far in the future from freezing indefinitely. |

**How it works:** At store time, the parser scans the fact text for ISO-8601 dates and natural-language date phrases. If the earliest future date found is within `maxFreezeDays`, the fact's `decay_freeze_until` column is set to that Unix timestamp. The prune/decay jobs skip the fact until `decay_freeze_until` has passed.

---

## Episodic event log (#150)

The event log is **Layer 1** of the three-layer memory architecture — a high-fidelity, append-only journal of everything that happens during a session. It captures raw episodic events (facts learned, decisions made, actions taken, entities mentioned, preferences expressed, corrections) before deciding whether they deserve long-term storage.

The event log is enabled automatically when `autoCapture` is true; no explicit config is required. Tune archival behaviour with `eventLog`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "eventLog": {
            "archivalDays": 90,
            "archivePath": "~/.openclaw/event-archive"
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `archivalDays` | `90` | Days before consolidated event log entries are archived and deleted from SQLite |
| `archivePath` | `~/.openclaw/event-archive` | Directory for compressed `.jsonl.gz` archives |

The event log lives in `event-log.db` alongside `memory.db`. Unconsolidated events remain available for the Dream Cycle (`nightlyCycle`) to consolidate into Layer 2 facts. Consolidated events are archived after `archivalDays`.

**Three-layer architecture:**
```
Layer 1 — Event Log       Raw episodic events (event-log.db)
Layer 2 — Facts           SQLite + FTS5 (memory.db)
Layer 3 — Vector Index    LanceDB embeddings
```

For full API documentation see [extensions/memory-hybrid/docs/event-log.md](../extensions/memory-hybrid/docs/event-log.md).

---

## Local embedding providers (#153)

In addition to `openai` and `google`, the plugin supports **local** embedding providers that require no API key:

- **`ollama`** — connects to a locally running [Ollama](https://ollama.ai) server
- **`onnx`** — runs an ONNX model file directly in-process via `@xenova/transformers`

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "embedding": {
            "provider": "ollama",
            "model": "nomic-embed-text",
            "dimensions": 768,
            "endpoint": "http://localhost:11434"
          }
        }
      }
    }
  }
}
```

**Ollama example:**

| Key | Default | Description |
|-----|---------|-------------|
| `provider` | `openai` | Set to `"ollama"` |
| `model` | — | Ollama model name, e.g. `"nomic-embed-text"` (768-dim), `"mxbai-embed-large"` (1024-dim), `"all-minilm"` (384-dim) |
| `dimensions` | auto | Vector dimensions. Auto-detected for known models; required for unknown models. |
| `endpoint` | `http://localhost:11434` | Custom Ollama endpoint |

**ONNX example:**

```json
{
  "embedding": {
    "provider": "onnx",
    "onnxModelPath": "all-MiniLM-L6-v2",
    "dimensions": 384
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `provider` | — | Set to `"onnx"` |
| `onnxModelPath` | — | Model identifier or path, e.g. `"all-MiniLM-L6-v2"`, `"bge-small-en-v1.5"` |
| `onnxTokenizerPath` | — | Path to tokenizer JSON file (auto-resolved for known models) |
| `dimensions` | auto | Required for unknown ONNX models |

**Auto-migration on model switch:** Set `embedding.autoMigrate: true` to automatically re-embed all existing facts when the provider or model changes on startup. Without this, stale vectors in LanceDB will cause poor search quality until you run `openclaw hybrid-mem backfill-decay` manually.

---


## Local LLM session pre-filtering (#290)

Introduces an optional **two-tier session triage** step. A new `session-pre-filter` service calls a local Ollama model to classify session JSONL files as interesting (`kept`) or not (`skipped`), with a safe fallback that processes all sessions when Ollama is unreachable.

This integrates directly into bulk CLI workflows (`runDistillForCli`, directive/reinforcement extraction, and self-correction runs), reducing cloud LLM costs by up to 90% when re-indexing large session histories.

```json
{
  "plugins": {
    "openclaw-hybrid-memory": {
      "config": {
        "extraction": {
          "preFilter": {
            "enabled": true,
            "model": "qwen3:8b",
            "endpoint": "http://localhost:11434",
            "maxCharsPerSession": 2000
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable local LLM pre-filtering. |
| `model` | `"qwen3:8b"` | Ollama model identifier (e.g. `"qwen3:8b"` or `"ollama/qwen3:8b"`). The `"ollama/"` prefix is stripped automatically. |
| `endpoint` | `"http://localhost:11434"` | Optional. Falls back to `llm.providers.ollama.baseURL` if unset. |
| `maxCharsPerSession` | `2000` | Max chars of user messages extracted per session for triage. Higher values improve accuracy but increase local LLM call time. |

## Multi-model embedding registry (#158)

Use **multiple embedding models in parallel** — each model contributes a separate vector index, and results are merged via Reciprocal Rank Fusion (RRF) at retrieval time.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "embedding": {
            "provider": "openai",
            "apiKey": "${OPENAI_API_KEY}",
            "model": "text-embedding-3-small",
            "multiModels": [
              {
                "name": "text-embedding-3-small",
                "provider": "openai",
                "dimensions": 1536,
                "role": "general"
              },
              {
                "name": "nomic-embed-text",
                "provider": "ollama",
                "dimensions": 768,
                "role": "domain"
              }
            ]
          }
        }
      }
    }
  }
}
```

Each entry in `multiModels`:

| Key | Required | Description |
|-----|----------|-------------|
| `name` | ✅ | Model identifier (e.g. `"text-embedding-3-small"`, `"nomic-embed-text"`) |
| `provider` | ✅ | `"openai"`, `"ollama"`, or `"onnx"` |
| `dimensions` | ✅ | Output vector dimensions for this model |
| `role` | ✅ | `"general"`, `"domain"`, `"query"`, or `"custom"` |
| `apiKey` | — | Overrides `embedding.apiKey` for this model (OpenAI only) |
| `endpoint` | — | Overrides `embedding.endpoint` for this model (Ollama only) |
| `enabled` | `true` | Set to `false` to disable without removing the entry |

When `multiModels` is set, each fact is embedded by all enabled models at store time. At recall time, each model contributes a ranked list and RRF merges them into a single result. See [SEARCH-RRF-INGEST.md](SEARCH-RRF-INGEST.md) for RRF details.

---

## Contextual variants at index time (#159)

**Contextual variants** generate alternative phrasings of a fact at index time using a cheap LLM, then embed all variants alongside the original. This improves recall for paraphrased queries without expanding the query at retrieval time.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "contextualVariants": {
            "enabled": true,
            "model": "openai/gpt-4.1-nano",
            "maxVariantsPerFact": 2,
            "maxPerMinute": 30,
            "categories": ["preference", "fact"]
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable contextual variant generation at store time |
| `model` | `openai/gpt-4.1-nano` | LLM for variant generation |
| `maxVariantsPerFact` | `2` | Max alternative phrasings per fact (capped at 5) |
| `maxPerMinute` | `30` | Rate limit on LLM calls to avoid bursting |
| `categories` | (all) | Restrict variant generation to facts in these categories. Omit to apply to all categories. |

Variants are stored as additional LanceDB vectors linked to the parent fact. At recall, any matching variant surfaces its parent.

---

## LLM re-ranking (#161)

After RRF fusion produces the initial ranked list, **LLM re-ranking** re-orders the top candidates using a language model that understands semantic context beyond embedding similarity.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "reranking": {
            "enabled": true,
            "model": "openai/gpt-4.1-nano",
            "candidateCount": 50,
            "outputCount": 20,
            "timeoutMs": 10000
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable LLM re-ranking of RRF fusion results |
| `model` | `openai/gpt-4.1-nano` | LLM for re-ranking |
| `candidateCount` | `50` | Top-N RRF candidates to present to the LLM |
| `outputCount` | `20` | Results to return after re-ranking |
| `timeoutMs` | `10000` | LLM call timeout in ms; on timeout, falls back to original RRF order |

Re-ranking runs for both `memory_recall` (explicit) and auto-recall (ambient injection) when enabled.

---

## Verification store (#162)

The verification store provides an **integrity layer** for critical facts. Verified facts are persisted to an append-only JSON backup and tracked for scheduled re-verification, ensuring that important memories remain accurate over time.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "verification": {
            "enabled": true,
            "backupPath": "~/.openclaw/verified-facts.json",
            "reverificationDays": 30,
            "autoClassify": true,
            "continuousVerification": false,
            "cycleDays": 30
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable the verification store |
| `backupPath` | `~/.openclaw/verified-facts.json` | Path to the append-only backup file |
| `reverificationDays` | `30` | Days until a verified fact should be re-verified |
| `autoClassify` | `true` | Automatically enroll facts tagged as `critical` into verification |
| `continuousVerification` | `false` | Enable continuous background re-verification cycle |
| `cycleDays` | `30` | Days between continuous verification cycles |
| `verificationModel` | (nano tier) | LLM for continuous verification; omit to use default nano model |

**Agent tools:**

| Tool | Description |
|------|-------------|
| `memory_verify` | Mark a fact as verified. Params: `factId: string` |
| `memory_verified_list` | List all verified facts with verification metadata |
| `memory_verification_status` | Check whether a specific fact is verified. Params: `factId: string` |

**Example usage:**
```
memory_verify(factId: "abc-123")
→ "Verified fact abc-123 (verification id: v-xyz)."

memory_verified_list()
→ "- abc-123 (v1) verified_at=2026-03-08T12:00:00Z: My AWS account ID is 123456789..."

memory_verification_status(factId: "abc-123")
→ "Fact abc-123 is verified (v1), verified_at=2026-03-08T12:00:00Z."
```

---

## Provenance tracing (#163)

**Provenance tracing** records the origin chain of every fact — which session it came from, which episodic events it was derived from, and which other facts it was consolidated from. This creates an auditable trail from any stored fact back to its raw source material.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "provenance": {
            "enabled": true,
            "retentionDays": 365
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable provenance tracing (opt-in; requires additional storage) |
| `retentionDays` | `365` | Days to retain provenance edges before pruning |

Provenance data is stored in a separate `provenance.db` alongside `memory.db`. Edges use the `DERIVED_FROM` type to link facts to their source events and `CONSOLIDATED_FROM` to link consolidated facts to their pre-merge predecessors.

**Agent tool: `memory_provenance`**

Returns the full provenance chain for a fact, traversing up to 10 hops.

```
memory_provenance(factId: "abc-123")
```

Returns:
```json
{
  "fact": { "id": "abc-123", "text": "...", "confidence": 0.9 },
  "source": {
    "session_id": "session-42",
    "timestamp": "2026-03-08T10:00:00.000Z",
    "turn": 5,
    "extraction_method": "auto_capture",
    "extraction_confidence": 0.85
  },
  "derivedFrom": [
    {
      "event_id": "evt-456",
      "event_text": "User said: my API key is...",
      "timestamp": "2026-03-08T10:00:00.000Z",
      "source_type": "event_log"
    }
  ],
  "consolidationChain": []
}
```

**When provenance is disabled**, calling `memory_provenance` returns a message explaining that provenance tracing must be enabled. Disabling provenance does **not** affect normal memory operations.

---

## Document ingestion (#206)

The document ingestion feature converts files (PDF, DOCX, XLSX, PPTX, HTML, images, and more) to Markdown via the **MarkItDown Python bridge**, chunks the result, and stores each chunk as a fact. This makes the content of documents searchable through normal memory recall.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "documents": {
            "enabled": true,
            "pythonPath": "python3",
            "chunkSize": 2000,
            "chunkOverlap": 200,
            "maxDocumentSize": 52428800,
            "autoTag": true,
            "visionEnabled": false,
            "allowedPaths": ["/home/user/docs", "/data/reports"]
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable the `memory_ingest_document` and `memory_ingest_folder` tools (opt-in) |
| `pythonPath` | `"python3"` | Python executable to use for the MarkItDown bridge |
| `chunkSize` | `2000` | Max characters per chunk when splitting the converted Markdown |
| `chunkOverlap` | `200` | Character overlap between consecutive chunks |
| `maxDocumentSize` | `52428800` | Max file size in bytes before rejection (default 50 MB) |
| `autoTag` | `true` | Automatically add the filename as a tag to all ingested facts |
| `visionEnabled` | `false` | Use LLM vision for image files (PNG, JPG, etc.) instead of MarkItDown |
| `visionModel` | (llm.default) | Vision model to use when `visionEnabled` is true |
| `allowedPaths` | — | Allowlist of absolute directory paths; ingestion is restricted to files under these paths when set |

**Supported file types:** PDF, DOC/DOCX, PPT/PPTX, XLS/XLSX, CSV, TSV, Markdown, TXT, RTF, HTML, JSON, YAML, EPUB, ODF formats, and images (PNG, JPG, GIF, WebP, BMP, TIFF).

**Prerequisites:** Python 3 with `markitdown` installed:
```bash
pip install markitdown
```

**Agent tools:**

| Tool | Description |
|------|-------------|
| `memory_ingest_document` | Convert and store a single document as chunked facts |
| `memory_ingest_folder` | Recursively ingest all supported documents in a folder |

**`memory_ingest_document` parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | ✅ | Absolute path to the document file |
| `tags` | — | Additional tags to attach to each stored fact |
| `category` | — | Category for stored facts (default: `fact`) |
| `dryRun` | — | When `true`, convert and chunk but do NOT store — returns a preview |

**`memory_ingest_folder` parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | ✅ | Absolute path to the folder |
| `filter.glob` | — | Glob pattern to match files (e.g. `**/*.pdf`) |
| `filter.extensions` | — | File extensions to include (e.g. `[".pdf", ".docx"]`) |
| `tags` | — | Additional tags for all ingested facts |
| `category` | — | Category for all stored facts |
| `dryRun` | — | When `true`, list matching files without ingesting |

**Hash deduplication:** Each document is fingerprinted (SHA-256 of content). Ingesting the same file twice skips the second run and reports `skipped_duplicate`.

**Progress callbacks:** Long-running ingestion emits structured progress events (`{ stage, pct, message }`) so agents can report status to the user.

---

## Nightly dream cycle (nightlyCycle)

The dream cycle runs a nightly maintenance pipeline: prune expired facts → consolidate episodic event log entries into Layer 2 facts → reflect → reflect-rules. Disabled by default; enable with `nightlyCycle.enabled: true`. The corresponding cron job (`hybrid-mem:nightly-dream-cycle`) is added by `install` / `verify --fix` and exits 0 when the feature is disabled.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "nightlyCycle": {
            "enabled": false,
            "schedule": "45 2 * * *",
            "reflectWindowDays": 7,
            "pruneMode": "both",
            "consolidateAfterDays": 7,
            "maxUnconsolidatedAgeDays": 90
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable the nightly dream cycle |
| `schedule` | `"45 2 * * *"` | Cron expression for nightly run (default: 2:45 AM) |
| `reflectWindowDays` | `7` | Reflection window in days (passed to the reflect step) |
| `pruneMode` | `"both"` | `"expired"` = hard-prune only; `"decay"` = soft-decay only; `"both"` = both |
| `consolidateAfterDays` | `7` | Consolidate episodic event log entries older than this many days into Layer 2 facts |
| `maxUnconsolidatedAgeDays` | `90` | Max age (days) for unconsolidated event log entries before deletion |
| `model` | (llm.default) | LLM for the reflection step; omit to use the default tier |
| `eventLogArchivalDays` | (uses `eventLog.archivalDays`) | Override archival cutoff for event log entries during dream cycle |
| `eventLogArchivePath` | (uses `eventLog.archivePath`) | Override archive directory during dream cycle |

CLI: `openclaw hybrid-mem dream-cycle`

---

## Passive observer (passiveObserver)

The passive observer reads recent session transcripts on a timer and extracts facts automatically, without waiting for explicit `memory_store` calls. Useful for capturing information the agent hasn't been explicitly asked to store. Disabled by default (opt-in).

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "passiveObserver": {
            "enabled": false,
            "intervalMinutes": 15,
            "maxCharsPerChunk": 8000,
            "minImportance": 0.5,
            "deduplicationThreshold": 0.92
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable the passive observer |
| `intervalMinutes` | `15` | How often to scan recent transcripts (minutes) |
| `model` | (nano tier) | LLM for extraction; when unset, uses `llm.nano[0]` |
| `maxCharsPerChunk` | `8000` | Max characters per transcript chunk sent to LLM |
| `minImportance` | `0.5` | Minimum importance score (0–1) to store a fact |
| `deduplicationThreshold` | `0.92` | Cosine similarity above which a new fact is treated as a duplicate and skipped |
| `sessionsDir` | (auto) | Override sessions directory (default: same as `procedures.sessionsDir`) |

---

## Workflow tracking (workflowTracking)

Records tool-call sequences per session so the crystallization and self-extension features can detect patterns. Disabled by default; required for `crystallization` and `selfExtension`.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "workflowTracking": {
            "enabled": false,
            "maxTracesPerDay": 100,
            "retentionDays": 90
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable workflow trace recording (opt-in) |
| `maxTracesPerDay` | `100` | Maximum traces recorded per day across all sessions |
| `retentionDays` | `90` | Days to retain traces before auto-pruning |
| `goalExtractionModel` | (nano tier) | Model used for goal extraction from conversation context; when unset uses nano tier |

---

## Enhanced ambient retrieval (ambient)

Generates multiple queries per retrieval trigger using an LLM, then merges the results. More aggressive than standard auto-recall; useful when relevant memories may be phrased very differently from the current prompt. Disabled by default.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "ambient": {
            "enabled": false,
            "multiQuery": false,
            "topicShiftThreshold": 0.4,
            "maxQueriesPerTrigger": 4,
            "budgetTokens": 2000
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable enhanced ambient retrieval |
| `multiQuery` | `false` | When true, generate 2–4 queries per trigger instead of one |
| `topicShiftThreshold` | `0.4` | Cosine distance threshold (0–1) for detecting a topic shift that triggers a new retrieval |
| `maxQueriesPerTrigger` | `4` | Cap on LLM-generated queries per trigger (max 4) |
| `budgetTokens` | `2000` | Token budget for ambient context injection |

---

## Confidence reinforcement (reinforcement)

Boosts confidence on facts that are recalled or re-stored frequently. Enabled by default; helps frequently-used facts stay highly ranked while rare facts gradually fade.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "reinforcement": {
            "enabled": true,
            "passiveBoost": 0.1,
            "activeBoost": 0.05,
            "maxConfidence": 1.0,
            "similarityThreshold": 0.85,
            "maxEventsPerFact": 50,
            "diversityWeight": 1.0,
            "trackContext": true,
            "boostAmount": 1.0
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Enable confidence reinforcement on repeated mentions |
| `passiveBoost` | `0.1` | Confidence delta when a semantically similar fact is stored again |
| `activeBoost` | `0.05` | Confidence delta when a fact is retrieved via `memory_recall` |
| `maxConfidence` | `1.0` | Upper cap for confidence after reinforcement |
| `similarityThreshold` | `0.85` | Cosine similarity above which a new fact counts as a repeat of an existing one |
| `maxEventsPerFact` | `50` | Max reinforcement events stored per fact (FIFO eviction) |
| `diversityWeight` | `1.0` | Weight applied to diversity score when calculating effective boost |
| `trackContext` | `true` | When false, skip storing per-event context columns (topic/query snippets) |
| `boostAmount` | `1.0` | Base boost amount before diversity weighting is applied |

---

## Implicit feedback signals (implicitFeedback)

Detects **behavioral** signals from the conversation (rephrasing, corrections, abrupt topic changes, terse replies, etc.) and turns them into structured feedback events.

Defaults are **enabled** (opt-out). You can also control whether these signals feed into reinforcement and self-correction.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "implicitFeedback": {
            "enabled": true,
            "minConfidence": 0.5,
            "signalTypes": [
              "rephrase",
              "immediate_action",
              "topic_change",
              "grateful_close",
              "self_service",
              "escalation",
              "terse_response",
              "extended_engagement",
              "copy_paste",
              "correction_cascade",
              "silence_after_action"
            ],
            "rephraseThreshold": 0.8,
            "topicChangeThreshold": 0.3,
            "terseResponseRatio": 0.4,
            "feedToReinforcement": true,
            "feedToSelfCorrection": true,
            "trajectoryLLMAnalysis": false
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Enable implicit feedback detection |
| `minConfidence` | `0.5` | Minimum confidence to include a signal |
| `signalTypes` | *(all)* | Which signal types to detect (defaults to all supported types) |
| `rephraseThreshold` | `0.8` | Similarity threshold for rephrase detection |
| `topicChangeThreshold` | `0.3` | Similarity threshold for topic-change detection |
| `terseResponseRatio` | `0.4` | Fraction of avg message length below which `terse_response` fires |
| `feedToReinforcement` | `true` | Feed positive implicit signals into reinforcement |
| `feedToSelfCorrection` | `true` | Feed negative implicit signals into self-correction |
| `trajectoryLLMAnalysis` | `false` | Use LLM-based trajectory analysis instead of heuristic lesson extraction |

---

## Closed-loop measurement (closedLoop)

Computes effectiveness scores for rules/lessons by comparing outcome signals over a sliding window, and can automatically **deprecate** or **boost** rules based on measured impact.

Defaults are **enabled** (opt-out).

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "closedLoop": {
            "enabled": true,
            "measurementWindowDays": 7,
            "minSampleSize": 5,
            "autoDeprecateThreshold": -0.3,
            "autoBoostThreshold": 0.5,
            "runInNightlyCycle": true
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Enable closed-loop measurement |
| `measurementWindowDays` | `7` | Days before/after rule creation to compare |
| `minSampleSize` | `5` | Minimum feedback sample size before scoring |
| `autoDeprecateThreshold` | `-0.3` | Effect score threshold below which a rule is auto-deprecated |
| `autoBoostThreshold` | `0.5` | Effect score threshold above which a rule is boosted |
| `runInNightlyCycle` | `true` | Also run measurement during the nightly dream cycle |

---

## Mission Control dashboard (dashboard)

A built-in HTTP server that serves a **real-time web dashboard** (Issue #309). The dashboard auto-refreshes every 60 seconds and shows memory stats, cron job status, task queue, Forge agent state, recent GitHub PRs/issues, and LLM cost tracking for the last 7 days.

Enabled by default. Access it at `http://localhost:7700` while the gateway is running.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "dashboard": {
            "enabled": true,
            "port": 7700
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Start the dashboard HTTP server with the gateway. Set `false` to disable. |
| `port` | `7700` | Port to bind on `127.0.0.1`. Must be between 1024 and 65535. |

**Dashboard sections:**

| Section | What it shows |
|---------|---------------|
| 🧠 Memory Stats | Active/expired facts, vector index count, SQLite and LanceDB storage sizes |
| 📋 Task Queue | Current task in progress + last 5 completed tasks (from `~/.openclaw/workspace/state/task-queue/`) |
| ⚒️ Agent Status | Active Forge agent tasks (from `~/.openclaw/workspace/state/forge/*.json`). Agent avatars: 🦊 Maeve, ⚒️ Forge, 📚 Scholar, 🏠 Hearth, 🛡️ Warden, 🔧 Reaver |
| ⏰ Cron Jobs | All registered cron jobs with schedule, last run time, and status (from `~/.openclaw/cron/jobs.json`) |
| 🔀 Git Activity | Last 10 open PRs and issues via `gh` CLI (requires GitHub CLI installed and authenticated) |
| 💰 Cost Tracking (7d) | LLM cost breakdown by feature for the last 7 days (requires cost tracking enabled) |

**JSON API:** `GET /api/status` returns the same data as JSON for scripting or external monitoring tools.

**Notes:**
- The server binds to `127.0.0.1` only — it is not exposed to the network.
- Git activity requires the `gh` CLI; if unavailable, the section shows "gh CLI unavailable".
- LanceDB size is cached for 5 minutes to avoid blocking on large directory traversals.

---

## Error reporting (errorReporting)

Anonymous error reporting to GlitchTip/Sentry. **Enabled by default (opt-out)** in `community` mode.

See [ERROR-REPORTING.md](ERROR-REPORTING.md) for full privacy and audit details.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "errorReporting": {
            "enabled": true,
            "consent": true,
            "mode": "community",
            "sampleRate": 1.0,
            "environment": "production",
            "botName": "Maeve"
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Enable error reporting (set `false` to opt out) |
| `consent` | `true` | Consent gate (if `false`, reporter is disabled even when enabled) |
| `mode` | `"community"` | `community` uses the built-in DSN; `self-hosted` requires your own DSN |
| `dsn` | *(community DSN)* | Optional override DSN (community) or required DSN (self-hosted) |
| `environment` | `"production"` | Environment tag |
| `sampleRate` | `1.0` | Sampling rate (0.0–1.0) |
| `botId` | *(unset)* | Optional UUID tag for grouping errors by bot |
| `botName` | *(unset)* | Optional friendly name tag for grouping errors by bot |

---

## GraphRAG retrieval (graphRetrieval)

Controls BFS graph expansion in `memory_recall`. When a query returns top results, the plugin optionally traverses the link graph from those results to surface related context. Enabled by default but does **not** expand by default — pass `expandGraph: true` to the tool, or set `defaultExpand: true` to expand on every call.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "graphRetrieval": {
            "enabled": true,
            "defaultExpand": false,
            "maxExpandDepth": 3,
            "maxExpandedResults": 20
          }
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Enable GraphRAG expansion in `memory_recall` |
| `defaultExpand` | `false` | When true, expand the graph on every `memory_recall` call even without `expandGraph: true` (backward-compatible: false) |
| `maxExpandDepth` | `3` | Maximum BFS depth cap — `expandDepth` parameter is clamped to this value |
| `maxExpandedResults` | `20` | Maximum number of graph-expanded results appended to direct matches |

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
- [SEARCH-RRF-INGEST.md](SEARCH-RRF-INGEST.md) — RRF fusion, query expansion, document ingestion
- [../extensions/memory-hybrid/docs/event-log.md](../extensions/memory-hybrid/docs/event-log.md) — Episodic event log (Layer 1) API reference
