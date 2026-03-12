---
layout: default
title: LLMs and Providers
parent: Configuration
nav_order: 4
---
# LLMs and Providers

The hybrid-memory plugin uses **two kinds of model access**:

1. **Embeddings** — turn text into vectors for semantic search (auto-recall, dedup, ingest).
2. **Chat/completion** — distillation, reflection, classification, query expansion, self-correction, and other LLM-backed features.

The plugin calls provider APIs **directly** using the API keys you configure — it does not route LLM calls through the OpenClaw gateway's agent pipeline. Embeddings go directly to whichever embedding provider you configure (OpenAI, Ollama, ONNX, or Google).

---

## Prerequisites

| Requirement | Purpose |
|-------------|---------|
| **Embedding access** | Required. Configure `embedding.provider` and related settings (see [Embedding providers](#embedding-providers) below). Supported providers: OpenAI (requires API key), Ollama (local, no key), ONNX (local, no key), Google (requires API key). The plugin will not load without valid embedding config. |
| **Chat/completion access** | Optional for basic memory (capture/recall). Required for: distillation, reflection, auto-classify, query expansion, self-correction, ingest-files, proposals, build-languages. |

For full features you need at least one chat provider configured. The plugin works with any OpenAI-compatible API.

---

## How the plugin uses LLMs — tiers

Every LLM feature belongs to one of three tiers. The tier determines which model list is tried first.

| Tier | Features | Optimised for | Recommended models |
|------|----------|---------------|-------------------|
| **nano** | autoClassify, query expansion, classifyBeforeWrite, auto-recall summarize | Cheapest — runs on **every** chat message or write | `gemini-2.5-flash-lite`, `gpt-4.1-nano`, `claude-haiku-4-5` |
| **default** | reflection, language keywords, general analysis | Balanced quality/cost | `gemini-2.5-flash`, `claude-sonnet-4-6`, `gpt-4.1` |
| **heavy** | Session distillation, self-correction, persona proposals | Most capable; **long context critical** for distill | `gemini-3.1-pro-preview` (1024k), `claude-opus-4-6`, `o3` |

When `llm.nano` is not configured, nano ops fall back to `llm.default[0]`.

> **Why Gemini first for heavy?** Distillation processes entire session histories — up to 500k tokens. Google's Gemini Pro is currently the only model with 1024k context at the heavy tier, making it far more effective for distill than Claude Opus (195k) or OpenAI o3 (195k).

---

## Configuring models: `llm` block

Set `llm.nano`, `llm.default`, and `llm.heavy` with ordered model lists. The plugin tries each in order; if one fails (no key, rate limit, 5xx), it tries the next. Model IDs can be **with or without** a provider prefix: `gemini-3.1-pro-preview` and `google/gemini-3.1-pro-preview` are equivalent (the plugin infers `google/` for bare `gemini-*` names so the correct API is used; same for `claude-*` → `anthropic/`, `gpt-*`/`o1` → `openai/`).

**Gateway provider keys:** At startup the plugin merges the gateway’s provider config (e.g. `models.providers` or `llm.providers` in OpenClaw config) into its own `llm.providers`. So any API keys you have in the gateway (Anthropic, Minimax, etc.) are available to the plugin without duplicating them in the plugin config. Add that provider’s models to `llm.default` or `llm.heavy` (e.g. `minimax/your-model`) to use them. Plugin-explicit `llm.providers.<name>` always wins over the gateway merge for that provider.

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
| `nano` | Ordered list for ultra-cheap ops (autoClassify, query expansion, classifyBeforeWrite, summarize). Falls back to `default[0]` when unset. |
| `default` | Ordered list for default-tier features (reflection, language keywords, general analysis). |
| `heavy` | Ordered list for heavy-tier features (distillation, persona proposals, self-correction). |
| `providers` | Per-provider API config. Keys are provider prefixes from model IDs (`google`, `openai`, `anthropic`, etc.). See [Provider keys](#provider-api-keys) below. |
| `fallbackToDefault` | If `true`, after all list models fail, try one more fallback model. |
| `fallbackModel` | Optional. Last-resort model tried when `fallbackToDefault` is true. |

Use **exact `provider/model` IDs** as shown by `openclaw models list` (e.g. `google/gemini-2.5-flash`, `anthropic/claude-haiku-4-5`). Run `openclaw hybrid-mem verify --test-llm` to confirm all configured models reach their APIs.

---

## Zero-config: auto-derive from OpenClaw

When `llm` is **not configured** in the plugin, the plugin automatically derives model tiers from your OpenClaw `agents.defaults.model` (the same list shown by `openclaw models list`):

- **default tier**: **agent order** (primary then fallbacks) — reflection and general features use the same order you set in `openclaw.json`
- **heavy tier**: **capable first** — heavy models (`pro`, `opus`, `o3`) then medium then light, for distill/self-correction
- **nano tier**: **cheap first** — nano/light/medium only, so classify/summarize never start with Opus

This means a freshly installed plugin works with whatever models you have configured in OpenClaw — no `llm` block required. The verify output shows `(auto from agents.defaults.model)` when this is in effect.

**If your only model is heavy (e.g. Claude Opus):** The plugin detects when the gateway list is heavy-only and **prepends a cheap fallback** (`gpt-4.1-nano`, `gemini-2.0-flash-lite`, `claude-3-5-haiku`) to the default and nano tiers. That way maintenance tasks (classify, summarize, cron job runner, etc.) try a cheaper model first instead of running hundreds of tasks as Opus. Set **`llm.default`** and **`llm.nano`** explicitly in plugin config if you want to override. After upgrading, run **`openclaw hybrid-mem verify --fix`** so stored cron job models are re-resolved from the updated tiers.

---

## Provider API keys

Each provider in `llm.providers` can have:
- `apiKey` — the API key for that provider. Accepts a plain key string or any **SecretRef** format:
  - `"env:VAR_NAME"` — read from environment variable `VAR_NAME`
  - `"file:/path/to/file"` — read from a file (whitespace-trimmed)
  - `"${VAR_NAME}"` — template syntax resolved from environment variables
- `baseURL` — the OpenAI-compatible base URL (only needed for providers without built-in defaults)

### Built-in providers (no `baseURL` needed)

| Provider prefix | Built-in endpoint | Key source |
|-----------------|-------------------|------------|
| `google` | `https://generativelanguage.googleapis.com/v1beta/openai/` | `llm.providers.google.apiKey` or legacy `distill.apiKey` |
| `openai` | `https://api.openai.com/v1` | `llm.providers.openai.apiKey` or `embedding.apiKey` |
| `anthropic` | `https://api.anthropic.com/v1` | `llm.providers.anthropic.apiKey` (required; no fallback) |
| `minimax` | `https://api.minimax.io/v1` | `llm.providers.minimax.apiKey` or `MINIMAX_API_KEY` env var |

### MiniMax configuration

MiniMax M2.5 has a built-in endpoint — only the API key is required (no `baseURL` needed):

```json
"llm": {
  "providers": {
    "minimax": {
      "apiKey": "sk-cp-..."
    }
  },
  "nano": ["minimax/MiniMax-M2.5"]
}
```

The `baseURL` defaults to `https://api.minimax.io/v1` (global endpoint). Set it explicitly only if you need a regional or custom endpoint.

**Gateway key auto-merge:** If OpenClaw's gateway has a `minimax` provider configured (under `models.providers.minimax`), the plugin automatically picks up the API key — no duplication needed. Just add `minimax/MiniMax-M2.5` to your `llm.nano` or `llm.default` list.

**OAuth support:** MiniMax supports CLI OAuth via `minimax-portal:minimax-cli` in `auth.order`. When configured alongside an available gateway, requests route through the gateway automatically (same as Google and Anthropic).

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

### Ollama (local models — e.g. `qwen3:8b`)
- Configure Ollama as a provider with `baseURL: "http://localhost:11434/v1"` and a dummy `apiKey` (Ollama doesn't require a real key).
- **Qwen3 thinking mode:** Qwen3 models running via Ollama default to `enable_thinking=true`, which places the actual response in `message.reasoning_content` (May 2025+ standard) or the legacy `message.reasoning` field while leaving `message.content` empty. The plugin automatically falls back to these fields, so agents receive the full response without any configuration change. This is transparent — no special model flag or config is required.
- Other Ollama models (Llama, Mistral, Phi, etc.) are unaffected; they always populate `message.content` normally.

---

## What happens when a provider key is missing

If a model in `llm.nano`/`llm.default`/`llm.heavy` uses a provider with no configured API key, the plugin:
1. **Skips it immediately** (no retry) and moves to the next model in the list.
2. **Does not report it to error telemetry** (it's a config issue, not a runtime error). This holds even in mixed-failure scenarios where earlier models in the fallback chain failed for a different reason (e.g. rate limit or ECONNREFUSED) — if the final error is an unconfigured-provider error, GlitchTip reporting is suppressed.
3. **Queues a user-visible warning** whenever at least one model fails due to a missing key — the AI agent will see it on the next chat turn and can relay the config guidance to the user. The message distinguishes two cases: "No LLM provider keys are configured" (all models unconfigured) vs. "Some LLM provider keys are missing" (partial — some models failed for other reasons).

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

## Embedding providers

Embeddings are required. The plugin supports four providers — choose the one that fits your setup:

| Provider | `embedding.provider` | API key required | Notes |
|----------|---------------------|-----------------|-------|
| **OpenAI** | `"openai"` (default) | Yes (`embedding.apiKey`) | `text-embedding-3-small` (1536d) or `text-embedding-3-large` (3072d) |
| **Ollama** | `"ollama"` | No | Fully local. Any Ollama model (e.g. `nomic-embed-text`, `mxbai-embed-large`). Ollama must be running. |
| **ONNX** | `"onnx"` | No | Fully local. Models auto-downloaded from HuggingFace. Requires `onnxruntime-node`. |
| **Google** | `"google"` | Yes (Google API key) | `text-embedding-004` via Gemini API. Reuses `llm.providers.google.apiKey` or `distill.apiKey`. |

---

### OpenAI (default)

```json
"embedding": {
  "provider": "openai",
  "apiKey": "sk-proj-...",
  "model": "text-embedding-3-small"
}
```

**Optional fallback model list:** Set `embedding.models` to try multiple models in order on rate limit or failure. All models must have the **same vector dimension** (1536 for `text-embedding-3-small`, 3072 for `text-embedding-3-large`).

```json
"embedding": {
  "provider": "openai",
  "apiKey": "sk-proj-...",
  "model": "text-embedding-3-small",
  "models": ["text-embedding-3-small"]
}
```

---

### Ollama (fully local, no API key)

Requires a running [Ollama](https://ollama.com) instance (default: `http://localhost:11434`).

```json
"embedding": {
  "provider": "ollama",
  "model": "nomic-embed-text",
  "dimensions": 768,
  "endpoint": "http://localhost:11434"
}
```

Popular models and their dimensions:

| Model | Dimensions |
|-------|-----------|
| `nomic-embed-text` | 768 |
| `mxbai-embed-large` | 1024 |
| `all-minilm` | 384 |

> **Note:** The `dimensions` value must match what the model actually produces. Check your model's documentation.

**With OpenAI fallback:** If you also set `embedding.apiKey`, the plugin automatically falls back to OpenAI when Ollama is unavailable (using `FallbackEmbeddingProvider`):

```json
"embedding": {
  "provider": "ollama",
  "model": "nomic-embed-text",
  "dimensions": 768,
  "apiKey": "sk-proj-..."
}
```

---

### ONNX (fully local, no API key)

Runs inference locally using [ONNX Runtime](https://onnxruntime.ai/). Models are auto-downloaded from HuggingFace on first use and cached at `~/.cache/openclaw/onnx-embeddings/`.

**Prerequisites:** `npm install onnxruntime-node` in the extension directory.

```json
"embedding": {
  "provider": "onnx",
  "model": "all-MiniLM-L6-v2",
  "dimensions": 384
}
```

Supported models (auto-downloaded):

| Model | Dimensions |
|-------|-----------|
| `all-MiniLM-L6-v2` | 384 |
| `bge-small-en-v1.5` | 384 |

You can also provide a path to a local `.onnx` file:

```json
"embedding": {
  "provider": "onnx",
  "model": "/path/to/model.onnx",
  "dimensions": 384
}
```

**With OpenAI fallback:** If `onnxruntime-node` is not installed, the plugin can fall back to OpenAI automatically when `embedding.apiKey` is also set:

```json
"embedding": {
  "provider": "onnx",
  "model": "all-MiniLM-L6-v2",
  "dimensions": 384,
  "apiKey": "sk-proj-..."
}
```

---

### Google (Gemini API)

Uses Google's `text-embedding-004` model via the Gemini API's OpenAI-compatible endpoint. Reuses the Google API key from `llm.providers.google.apiKey` (or `distill.apiKey` as a fallback).

```json
"embedding": {
  "provider": "google",
  "model": "text-embedding-004",
  "dimensions": 768
},
"llm": {
  "providers": {
    "google": { "apiKey": "AIzaSy..." }
  }
}
```

Default dimensions for `text-embedding-004`: 768. Set `embedding.dimensions` explicitly to override.

---

### Ordered failover with `preferredProviders`

Use `embedding.preferredProviders` to define an ordered fallback chain. The plugin tries each provider in sequence; first success wins. This is the same pattern as LLM tier failover.

```json
"embedding": {
  "preferredProviders": ["ollama", "openai"],
  "model": "nomic-embed-text",
  "dimensions": 768,
  "apiKey": "sk-proj-..."
}
```

In this example: Ollama is tried first (local, free); if it fails, the plugin falls back to OpenAI automatically. Supported in `preferredProviders`: `"ollama"`, `"openai"`, `"google"`.

> **Constraint:** All providers in a chain must use the same vector dimensions. Design your chain accordingly (e.g. use a 768d Ollama model + OpenAI configured to 768d).

---

## Legacy: `distill` block

The `distill` block (with `apiKey` for a Google key and `defaultModel`) is still supported but deprecated in favour of `llm` + `llm.providers.google.apiKey`. If both are set, `llm` takes precedence.

```json
"distill": {
  "apiKey": "AIzaSy...",
  "defaultModel": "google/gemini-3.1-pro-preview"
}
```

The `distill.apiKey` is still used as a fallback key for `google/*` models when `llm.providers.google.apiKey` is not set. It also serves as the Google embedding key when `embedding.provider` is `google`. Accepts a plain key string or any **SecretRef** format: `"env:VAR_NAME"`, `"file:/path/to/file"`, or `"${VAR_NAME}"`.

---

## Summary

- **Direct API calls** — the plugin calls provider APIs directly, not through the OpenClaw gateway agent pipeline.
- **Three tiers** — `llm.nano` (cheap, high-frequency), `llm.default` (balanced), `llm.heavy` (capable, long-context).
- **Zero config** — when `llm` is not set, tiers are auto-derived from `agents.defaults.model`.
- **Any OpenAI-compatible provider** — configure via `llm.providers.<name>.{ apiKey, baseURL }` (with legacy `distill.apiKey` / `embedding.apiKey` fallbacks as noted above).
- **Built-in provider quirks handled** — Anthropic headers, o-series temperature stripping, GPT-5 max_completion_tokens remapping.
- **Graceful degradation** — missing key = skip model + notify user; no crash.

See [CONFIGURATION.md](CONFIGURATION.md) for the full config reference and [SESSION-DISTILLATION.md](SESSION-DISTILLATION.md) for distillation-specific usage.


### Local LLM Pre-filtering (Ollama)

For bulk operations (like `distill`), you can drastically reduce cloud API usage by enabling the two-tier local LLM pre-filter. A local model (e.g. `qwen3:8b`) triages sessions and only sends the interesting ones to the heavy cloud model.

```json
{
  "extraction": {
    "preFilter": {
      "enabled": true,
      "model": "qwen3:8b"
    }
  }
}
```

See [CONFIGURATION.md](CONFIGURATION.md#local-llm-session-pre-filtering-290) for details.
