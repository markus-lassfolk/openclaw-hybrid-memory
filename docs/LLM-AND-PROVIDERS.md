---
layout: default
title: LLMs and Providers
parent: Configuration
nav_order: 4
---
# LLMs and Providers

The hybrid-memory plugin uses **two kinds of model access**:

1. **Embeddings** — to turn text into vectors for semantic search (auto-recall, dedup, ingest).
2. **Chat/completion** — for distillation, reflection, classification, proposals, self-correction, HyDE, and other LLM-backed features.

All LLM calls are routed through the **OpenClaw gateway** (OpenAI-compatible API). You can use any provider the gateway supports: OpenAI, Google Gemini, Anthropic Claude, Groq, OpenRouter, local Ollama, etc. No provider-specific API keys are required in the plugin; the gateway handles keys and routing.

---

## Prerequisites

| Requirement | Purpose |
|-------------|---------|
| **Embedding access** | Required. You must configure an embedding model and a way for the gateway to call it (e.g. OpenAI key for `text-embedding-3-small`, or gateway-configured alternative). The plugin will not load without valid embedding config. |
| **Chat/completion access** | Optional for basic memory (capture/recall). Required for: distillation, reflection, auto-classify, consolidate, persona proposals, self-correction, ingest-files, HyDE, build-languages. Any model the gateway can serve is fine. |

So at minimum you need **one embedding-capable setup** (typically OpenAI or a gateway proxy). For full features you need **at least one chat model** available through the gateway. The plugin does not require a specific provider; it uses whatever models you configure and the gateway provides.

---

## How the plugin uses LLMs

### Embeddings (required)

- **Where:** Auto-recall (embed the user prompt), auto-capture and tools (embed new facts), ingest, consolidate, reflection (embed patterns/rules), self-correction (semantic dedup).
- **Config:** `embedding.model` (e.g. `text-embedding-3-small`) and an API key the gateway uses for that model. The plugin uses the **same OpenAI client as the gateway** for embeddings, so if the gateway is configured for a given embedding provider, embeddings go through it.
- **Cost:** One embedding call per recall turn plus per stored fact / search; typically low.

### Chat/completion (optional per feature)

| Feature | Tier | What it does |
|---------|------|---------------|
| **Session distillation** | Heavy | Extracts facts from session JSONL; benefits from large context (e.g. 1M tokens). |
| **Reflection / reflect-rules / reflect-meta** | Default | Synthesizes patterns and rules from facts. |
| **Auto-classify** | Default | Reclassifies "other" facts into categories. |
| **Consolidate** | Default | Merges near-duplicate facts (cluster + merge). |
| **Persona proposals** | Heavy | Generates proposed identity file changes. |
| **Self-correction (analyze, TOOLS rewrite)** | Heavy / default | Analyzes incidents, optionally rewrites TOOLS.md. |
| **Ingest-files** | Default | Extracts facts from markdown. |
| **HyDE (search)** | Default | Expands query into a hypothetical answer before embedding. |
| **Build-languages** | Default | Detects languages and builds keyword file. |
| **Store classify-before-write** | Default | ADD/UPDATE/DELETE/NOOP before storing. |

**Tier** affects which model list is used when you configure **`llm`** (see below): `default` for most features, `heavy` for distillation, spawn, and persona proposals.

---

## Configuring models: `llm` (recommended)

Use the **`llm`** block to give the plugin an ordered list of models per tier. The plugin tries the first model; if it fails (e.g. no key, 429, 5xx), it tries the next, and so on. This works with the OpenClaw gateway’s model routing and any provider the gateway supports.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "embedding": {
            "apiKey": "sk-...",
            "model": "text-embedding-3-small"
          },
          "llm": {
            "default": ["gemini-2.0-flash", "claude-sonnet-4", "gpt-4o-mini"],
            "heavy": ["gemini-2.0-flash-thinking", "claude-opus-4", "gpt-4o"],
            "fallbackToDefault": true
          }
        }
      }
    }
  }
}
```

| Key | Description |
|-----|-------------|
| `default` | Ordered list of models for default-tier features (reflection, classify, consolidate, ingest, HyDE, build-languages, etc.). First working model wins. |
| `heavy` | Ordered list for heavy-tier features (distillation, persona proposals, self-correction spawn). |
| `fallbackToDefault` | If `true`, after trying all models in the list, try one more fallback model (see below). |
| `fallbackModel` | Optional. When `fallbackToDefault` is true, this model is used as the final try. If omitted, the plugin uses a built-in default (e.g. `gpt-4o-mini` for default tier, `gpt-4o` for heavy). |

**Fallback behaviour:** For each LLM call the plugin (1) tries each model in the list in order, (2) on failure (no key, 401, 403, 5xx, etc.) tries the next, (3) if `fallbackToDefault` is true and all list models failed, tries `fallbackModel` or the tier default, (4) only then fails the request.

When **`llm`** is set, maintenance jobs and CLI commands (distill, reflect, classify, etc.) use these lists. When **`llm`** is not set, the plugin falls back to **legacy** behaviour (see below).

---

## Legacy model selection (when `llm` is not set)

If you do **not** configure `llm`, the plugin picks a single model per tier from what you have configured:

| Priority | Condition | Model used (default tier) | Model used (heavy tier) |
|----------|-----------|---------------------------|--------------------------|
| 1 | `distill.apiKey` set | `distill.defaultModel` or `gemini-2.0-flash` | same or heavy default |
| 2 | `claude.apiKey` set | `claude.defaultModel` or Claude Sonnet | Claude Opus |
| 3 | `embedding.apiKey` set | `reflection.model` or `gpt-4o-mini` | `gpt-4o` |

The old **`distill`** block (`apiKey`, `defaultModel`, `fallbackModels`) is still supported but deprecated in favour of gateway + `llm`. Existing config keeps working.

---

## Embedding configuration

Embeddings are required. Typical setup:

```json
"embedding": {
  "apiKey": "sk-...",
  "model": "text-embedding-3-small"
}
```

The plugin uses this client for both **embeddings** and **chat** (when no separate gateway client is provided). So the same key/model can back vector search and, if you don’t set `llm`, the legacy default chat model. For best flexibility, use the OpenClaw gateway for chat and optional `llm` preference lists; keep `embedding` for vector search.

Supported embedding dimensions depend on `model` (e.g. `text-embedding-3-small` → 1536, `text-embedding-3-large` → 3072). See [CONFIGURATION.md](CONFIGURATION.md) for full options.

---

## Summary

- **Prerequisites:** Embedding access (required); chat access (optional, for distillation/reflection/classify/etc.).
- **Provider-agnostic:** All LLM calls go through the OpenClaw gateway; any gateway-supported provider works.
- **Recommended:** Set **`llm.default`** and **`llm.heavy`** with ordered model lists and **`fallbackToDefault: true`** so the plugin can try alternatives when one model fails.
- **Legacy:** Without `llm`, the plugin still uses `distill` / `claude` / `embedding` to choose a single model per tier.

See [CONFIGURATION.md](CONFIGURATION.md) for the full config reference and [SESSION-DISTILLATION.md](SESSION-DISTILLATION.md) for distillation-specific usage.
