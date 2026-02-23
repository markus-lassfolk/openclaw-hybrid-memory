---
layout: default
title: LLMs and Providers
parent: Configuration
nav_order: 4
---
# LLMs and Providers

The hybrid-memory plugin uses **two kinds of model access**:

1. **Embeddings** — turn text into vectors for semantic search (auto-recall, dedup, ingest).
2. **Chat/completion** — distillation, reflection, classification, HyDE, self-correction, and other LLM-backed features.

The plugin calls provider APIs **directly** using the API keys you configure — it does not route LLM calls through the OpenClaw gateway's agent pipeline. Embeddings always go directly to OpenAI.

---

## Prerequisites

| Requirement | Purpose |
|-------------|---------|
| **Embedding access** | Required. An OpenAI API key and embedding model (e.g. `text-embedding-3-small`). The plugin will not load without valid embedding config. |
| **Chat/completion access** | Optional for basic memory (capture/recall). Required for: distillation, reflection, auto-classify, HyDE, self-correction, ingest-files, proposals, build-languages. |

For full features you need at least one chat provider configured. The plugin works with any OpenAI-compatible API.

---

## How the plugin uses LLMs — tiers

Every LLM feature belongs to one of three tiers. The tier determines which model list is tried first.

| Tier | Features | Optimised for | Recommended models |
|------|----------|---------------|-------------------|
| **nano** | autoClassify, HyDE, classifyBeforeWrite, auto-recall summarize | Cheapest — runs on **every** chat message or write | `gemini-2.5-flash-lite`, `gpt-4.1-nano`, `claude-haiku-4-5` |
| **default** | reflection, language keywords, general analysis | Balanced quality/cost | `gemini-2.5-flash`, `claude-sonnet-4-6`, `gpt-4.1` |
| **heavy** | Session distillation, self-correction, persona proposals | Most capable; **long context critical** for distill | `gemini-3.1-pro-preview` (1024k), `claude-opus-4-6`, `o3` |

When `llm.nano` is not configured, nano ops fall back to `llm.default[0]`.

> **Why Gemini first for heavy?** Distillation processes entire session histories — up to 500k tokens. Google's Gemini Pro is currently the only model with 1024k context at the heavy tier, making it far more effective for distill than Claude Opus (195k) or OpenAI o3 (195k).

---

## Configuring models: `llm` block

Set `llm.nano`, `llm.default`, and `llm.heavy` with ordered model lists. The plugin tries each in order; if one fails (no key, rate limit, 5xx), it tries the next.

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "embedding": {
            "apiKey": "sk-proj-...",
            "model": "text-embedding-3-small"
          },
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
| `nano` | Ordered list for ultra-cheap ops (autoClassify, HyDE, classifyBeforeWrite, summarize). Falls back to `default[0]` when unset. |
| `default` | Ordered list for default-tier features (reflection, language keywords, general analysis). |
| `heavy` | Ordered list for heavy-tier features (distillation, persona proposals, self-correction). |
| `providers` | Per-provider API config. Keys are provider prefixes from model IDs (`google`, `openai`, `anthropic`, etc.). See [Provider keys](#provider-api-keys) below. |
| `fallbackToDefault` | If `true`, after all list models fail, try one more fallback model. |
| `fallbackModel` | Optional. Last-resort model tried when `fallbackToDefault` is true. |

Use **exact `provider/model` IDs** as shown by `openclaw models list` (e.g. `google/gemini-2.5-flash`, `anthropic/claude-haiku-4-5`). Run `openclaw hybrid-mem verify --test-llm` to confirm all configured models reach their APIs.

---

## Zero-config: auto-derive from OpenClaw

When `llm` is **not configured** in the plugin, the plugin automatically derives model tiers from your OpenClaw `agents.defaults.model` (the same list shown by `openclaw models list`):

- **nano tier**: models with `nano`, `mini`, `haiku`, or `lite` in their name
- **default tier**: all models, lighter first
- **heavy tier**: all models, heavier first (`pro`, `opus`, `o3` etc. come first)

This means a freshly installed plugin works with whatever models you have configured in OpenClaw — no `llm` block required. The verify output shows `(auto from agents.defaults.model)` when this is in effect.

---

## Provider API keys

Each provider in `llm.providers` can have:
- `apiKey` — the API key for that provider
- `baseURL` — the OpenAI-compatible base URL (only needed for providers without built-in defaults)

### Built-in providers (no `baseURL` needed)

| Provider prefix | Built-in endpoint | Key source |
|-----------------|-------------------|------------|
| `google` | `https://generativelanguage.googleapis.com/v1beta/openai/` | `llm.providers.google.apiKey` or legacy `distill.apiKey` |
| `openai` | `https://api.openai.com/v1` | `llm.providers.openai.apiKey` or `embedding.apiKey` |
| `anthropic` | `https://api.anthropic.com/v1` | `llm.providers.anthropic.apiKey` (required; no fallback) |

### Manual provider configuration required

Providers must be configured in the plugin's `llm.providers` section. While OpenClaw's `models.providers` are shown in verify output for reference, they are not automatically used by the plugin's multi-provider proxy.

For any provider beyond the built-ins, add them to `llm.providers`:

```json
"llm": {
  "providers": {
    "minimax": {
      "apiKey": "sk-cp-...",
      "baseURL": "https://api.minimax.io/v1"
    }
  },
  "nano": ["minimax/MiniMax-M2.5"]
}
```

### Any other OpenAI-compatible provider

For providers not auto-detected, add them to `llm.providers`:

```json
"llm": {
  "providers": {
    "mistral": {
      "apiKey": "your-mistral-key",
      "baseURL": "https://api.mistral.ai/v1"
    },
    "deepseek": {
      "apiKey": "your-deepseek-key",
      "baseURL": "https://api.deepseek.com/v1"
    }
  }
}
```

---

## Provider-specific behaviours

### Google Gemini
- Uses the OpenAI-compatible Gemini endpoint; standard `temperature`, `max_tokens` apply.
- Model IDs use the bare name (`gemini-2.5-flash`); the plugin strips the `google/` prefix automatically before calling the API.

### Anthropic Claude
- Uses Anthropic's `/v1/chat/completions` OpenAI-compatible endpoint.
- **Requires** `llm.providers.anthropic.apiKey`. Authentication uses `Authorization: Bearer <key>`.
- The plugin automatically adds the required `anthropic-version: 2023-06-01` header.

### OpenAI (including o-series reasoning models)
- Newer models (GPT-5+) require `max_completion_tokens` instead of `max_tokens`. The plugin remaps automatically.
- Reasoning models (`o1`, `o3`, `o4-mini`, etc.) do not accept `temperature` or `top_p`. The plugin strips these parameters automatically for any model matching `o[0-9]*`.

---

## What happens when a provider key is missing

If a model in `llm.nano`/`llm.default`/`llm.heavy` uses a provider with no configured API key, the plugin:
1. **Skips it immediately** (no retry) and moves to the next model in the list.
2. **Does not report it to error telemetry** (it's a config issue, not a runtime error).
3. **Queues a user-visible warning** if *all* models fail due to missing keys — the AI agent will see it on the next chat turn and can relay the config guidance to the user.

Run `openclaw hybrid-mem verify --test-llm` to see which models are reachable and which are skipped.

---

## Recommended model matrix

| Tier | Google | Anthropic | OpenAI |
|------|--------|-----------|--------|
| **nano** | `gemini-2.5-flash-lite` | `claude-haiku-4-5` | `gpt-4.1-nano` |
| **default** | `gemini-2.5-flash` | `claude-sonnet-4-6` | `gpt-4.1` |
| **heavy** | `gemini-3.1-pro-preview` | `claude-opus-4-6` | `o3` |

**Provider order rationale (Gemini → Anthropic → OpenAI):**
- **Gemini first** — only provider with 1024k context at all tiers; Gemini Flash-Lite is the most cost-effective nano model; critical for distillation.
- **Anthropic second** — haiku/sonnet/opus map cleanly to nano/default/heavy; strong quality.
- **OpenAI third** — excellent fallback; `gpt-4.1-nano` is purpose-built for cheap classification; `o3` adds deep reasoning for heavy ops.

**Excluded from the matrix:**
- Live/streaming models (`gemini-live-*`), deep-research (`o3-deep-research`), code-only models (`codex-*`), o3-mini/o4-mini (reasoning despite "mini" name — expensive and don't accept `temperature`).

---

## Verify your configuration

```bash
openclaw hybrid-mem verify
```
Shows the effective model for each tier and each feature (with source annotation: "from llm.nano", "from llm.default", "auto from agents.defaults.model").

```bash
openclaw hybrid-mem verify --test-llm
```
Calls each configured model with a minimal prompt and reports ✅ reachable / ❌ failed / ⚠️ skipped (no key). Tests all three tiers.

---

## Embedding configuration

Embeddings are required and always go directly to OpenAI.

```json
"embedding": {
  "apiKey": "sk-proj-...",
  "model": "text-embedding-3-small"
}
```

**Optional fallback list:** Set `embedding.models` to try multiple models in order on rate limit or failure. All models must have the **same vector dimension** (1536 for `text-embedding-3-small`, 3072 for `text-embedding-3-large`).

```json
"embedding": {
  "apiKey": "sk-proj-...",
  "model": "text-embedding-3-small",
  "models": ["text-embedding-3-small"]
}
```

---

## Legacy: `distill` block

The `distill` block (with `apiKey` for a Google key and `defaultModel`) is still supported but deprecated in favour of `llm` + `llm.providers.google.apiKey`. If both are set, `llm` takes precedence.

```json
"distill": {
  "apiKey": "AIzaSy...",
  "defaultModel": "google/gemini-3.1-pro-preview"
}
```

The `distill.apiKey` is still used as a fallback key for `google/*` models when `llm.providers.google.apiKey` is not set.

---

## Summary

- **Direct API calls** — the plugin calls provider APIs directly, not through the OpenClaw gateway agent pipeline.
- **Three tiers** — `llm.nano` (cheap, high-frequency), `llm.default` (balanced), `llm.heavy` (capable, long-context).
- **Zero config** — when `llm` is not set, tiers are auto-derived from `agents.defaults.model`.
- **Any OpenAI-compatible provider** — configure via `llm.providers.<name>.{ apiKey, baseURL }` or via OpenClaw's `models.providers` (auto-detected).
- **Built-in provider quirks handled** — Anthropic headers, o-series temperature stripping, GPT-5 max_completion_tokens remapping.
- **Graceful degradation** — missing key = skip model + notify user; no crash.

See [CONFIGURATION.md](CONFIGURATION.md) for the full config reference and [SESSION-DISTILLATION.md](SESSION-DISTILLATION.md) for distillation-specific usage.
