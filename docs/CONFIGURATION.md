# Configuration Reference

All settings live in `~/.openclaw/openclaw.json`. Merge these into your existing config. Replace placeholders; do **not** commit real API keys to git.

**Quick setup:** Run `openclaw hybrid-mem install` to apply all recommended defaults at once. Then customise as needed below.

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

Optional: `lanceDbPath` and `sqlitePath` (defaults: `~/.openclaw/memory/lancedb` and `~/.openclaw/memory/facts.db`).

---

## Auto-capture and auto-recall

`captureMaxChars` (default 5000): messages longer than this are not captured; stored text is truncated to this length.

`store.fuzzyDedupe` (default `false`): enables fuzzy deduplication — before storing, normalizes text, hashes it, skips if an existing fact has the same hash.

### Auto-recall options

`autoRecall` can be `true` (defaults) or an object:

```json
{
  "autoRecall": {
    "enabled": true,
    "maxTokens": 800,
    "maxPerMemoryChars": 0,
    "injectionFormat": "full",
    "limit": 5,
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
    "useSummaryInInjection": true
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `maxTokens` | `800` | Total tokens injected per turn |
| `maxPerMemoryChars` | `0` | Truncate each memory to N chars (0 = no truncation) |
| `injectionFormat` | `"full"` | Per-memory line: `full` = `[backend/category] text`, `short` = `category: text`, `minimal` = text only |
| `limit` | `5` | Max memories considered for injection |
| `minScore` | `0.3` | Minimum vector search score (0–1) |
| `preferLongTerm` | `false` | Boost permanent (×1.2) and stable (×1.1) facts |
| `useImportanceRecency` | `false` | Combine relevance with importance and recency |
| `entityLookup.enabled` | `false` | Merge entity lookup facts when prompt mentions an entity |
| `summaryThreshold` | `300` | Facts longer than this get a stored summary |
| `summaryMaxChars` | `80` | Max chars for the summary |
| `useSummaryInInjection` | `true` | Use summary in injection to save tokens |

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

The five defaults (`preference`, `fact`, `decision`, `entity`, `other`) are always included. See [FEATURES.md](FEATURES.md) for details on categories and discovery.

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
