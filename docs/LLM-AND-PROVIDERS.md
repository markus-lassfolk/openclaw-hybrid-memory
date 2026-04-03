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

For **chat/completion**, you can use either **API keys** (in plugin or gateway config) or **OAuth** (recommended for many users — no paid keys, sign in once via `openclaw configure`). When OAuth is configured for a provider, the plugin sends LLM requests through the OpenClaw gateway; the gateway resolves your OAuth token and forwards to the provider. Embeddings still go directly to whichever embedding provider you configure (OpenAI, Ollama, ONNX, or Google).

**Azure / Microsoft Foundry:** Gateway model catalog vs hybrid-memory `llm` (two layers), `api-key` header, and links — see [Azure Foundry and OpenClaw](AZURE-FOUNDRY-AND-OPENCLAW.md).

---

## Prerequisites

| Requirement | Purpose |
|-------------|---------|
| **Embedding access** | Required. Configure `embedding.provider` and related settings (see [Embedding providers](#embedding-providers) below). Supported providers: OpenAI (requires API key), Ollama (local, no key), ONNX (local, no key), Google (requires API key). The plugin will not load without valid embedding config. |
| **Chat/completion access** | Optional for basic memory (capture/recall). Required for: distillation, reflection, auto-classify, query expansion, self-correction, ingest-files, proposals, build-languages. Use **API keys** (plugin or gateway) **or OAuth** — see [OAuth authentication](#oauth-authentication) below. |

For full features you need at least one chat provider configured. The plugin works with any OpenAI-compatible API and with **full OAuth support** when the OpenClaw gateway is running.

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

For **context window**, **max output tokens**, **model versions**, and **training data cutoff** per model (Azure and others), see [Model reference (context, tokens, versions)](MODEL-REFERENCE.md).

---

## OAuth authentication

Many users prefer **OAuth** over paid API keys: you sign in once (e.g. via Claude CLI, Google Gemini CLI, or MiniMax portal) and the OpenClaw gateway uses that session for all LLM calls from the plugin. No API key in config, no per-call key costs. The plugin supports **full OAuth** for chat/completion: when a provider has an OAuth profile in `auth.order`, the plugin routes that provider’s requests through the gateway, which resolves the token and forwards to the real API.

### Why use OAuth

- **No API keys to buy or store** — use your existing OAuth sign-in (Claude Code, Gemini CLI, etc.).
- **Same features** — distillation, reflection, auto-classify, self-correction, and all other LLM features work exactly as with API keys.
- **First-class path** — OAuth is not a fallback; it’s a supported authentication path that many users rely on.

### Supported OAuth / token profiles

Set these in `auth.order` (plugin config or gateway). Profiles are set up via `openclaw configure`; the gateway then resolves the token when the plugin sends a request.

| Provider | Profile ID | Description |
|----------|------------|-------------|
| **Anthropic** | `anthropic:claude-cli` | Claude Code CLI OAuth |
| **OpenAI** | `openai-codex` | OpenAI Codex OAuth |
| **OpenAI** | `github-copilot` | GitHub Copilot token (device code flow) |
| **Google** | `google-gemini-cli` | Gemini CLI OAuth |
| **Google** | `google-vertex` | Google Vertex AI OAuth |
| **Qwen** | `qwen-portal:qwen-cli` | Qwen Code CLI OAuth |
| **MiniMax** | `minimax-portal:minimax-cli` | MiniMax CLI OAuth |

You can list API-key profiles as fallbacks (e.g. `anthropic:api`) so that if OAuth is missing or expired, the plugin tries the key next.

### How to configure

1. **Run `openclaw configure`** (or your OpenClaw setup) and complete OAuth for the providers you want (e.g. Claude CLI, Gemini CLI).
2. **Set `auth.order`** in your plugin config (or gateway config) so the plugin knows to use OAuth for those providers. Example:

```json
"auth": {
  "order": {
    "anthropic": ["anthropic:claude-cli", "anthropic:api"],
    "google": ["google-gemini-cli", "google:default"],
    "openai": ["openai-codex", "openai:api"],
    "minimax": ["minimax-portal:minimax-cli", "minimax:api"]
  }
}
```

3. **Ensure the OpenClaw gateway is running** so the plugin can reach it (and has a valid gateway token). The plugin does not call providers directly when OAuth is used; it always goes through the gateway.
4. **Set your model lists** (`llm.nano` / `llm.default` / `llm.heavy`) with the `provider/model` IDs you want, or leave `llm` unset for zero-config (tiers derived from `agents.defaults.model`).
5. **Optional: disable a provider** — If a provider is in your tier lists but you want hybrid-memory to never use it (e.g. low credits), set `llm.disabledProviders` to an array of provider IDs, e.g. `["anthropic"]`. Disabled providers are excluded from all LLM calls and from the “providers with keys” list; they still appear in `openclaw hybrid-mem verify` with **Enabled: Disabled**.

### Prefer OAuth when both OAuth and API key exist

When a provider has both OAuth profiles and an API key configured, the plugin **prefers OAuth by default**. You can turn this off with:

```json
"auth": {
  "preferOAuthWhenBoth": false
}
```

If OAuth fails (e.g. gateway or token issues), the plugin records a failure and **falls back to the API key** for that provider. To avoid hammering OAuth while it’s broken, it uses **incremental backoff**: after a failure it won’t try OAuth again until a waiting period has passed. The default schedule is: **5 min → 30 min → 1 h → 2 h → 4 h**. After the last step, OAuth is retried only after the backoff expires or the counter is reset.

- **`auth.backoffScheduleMinutes`** — array of minutes to wait at each failure level (default: `[5, 30, 60, 120, 240]`).
- **`auth.resetBackoffAfterHours`** — after this many hours with no read of the backoff state, all per-provider backoff is cleared so the next call tries OAuth again (default: `24`).

To **clear backoff immediately** so the next LLM calls try OAuth again:

```bash
openclaw hybrid-mem reset-auth-backoff
```

### OAuth-only (no API keys)

If you use **only** OAuth and do not add any API keys to OpenClaw, everything above still applies. The plugin never needs an `apiKey` in config for those providers. The only caveat: **verify** and “providers with keys” logic only consider explicit API keys, so they may report no LLM keys or skip OAuth providers in `--test-llm` even though **at runtime** those models work via the gateway. So OAuth-only setups work; the verify output can look understated until we extend it for OAuth.

### Verify and OAuth — do we test it?

**Yes.** Run `openclaw hybrid-mem verify` to see **Embeddings Tests (Critical)** and **LLM Providers** tables without running live tests. Run `openclaw hybrid-mem verify --test-llm` to run minimal completions and show **OAuth Result** and **API Result** separately.

When a provider has both OAuth and API credentials, both paths are tested: one request goes through the gateway (OAuth) and one uses the direct API key. So you can see e.g. **OAuth Result: ✅ Success** and **API Result: ❌ Failed** (or the other way around) and fix the failing path. Both tables show **Credentials Available** (OAuth / API) and **Source** (where the key comes from: `env`, `file`, `plugin`, `gateway`, or `local`). The LLM table also shows **Enabled/Disabled**. With `--test-llm`, only enabled providers are tested; disabled ones still show `—` for both result columns.

### Google Gemini (verify + plugin)

- **`distill.apiKey`** (or **`llm.providers.google.apiKey`**) is the Gemini / Google Generative Language API key used for `google/*` models and distill. Use **`env:GOOGLE_API_KEY`** and set `GOOGLE_API_KEY` in the environment (e.g. `~/.openclaw/.env` and systemd `EnvironmentFile` on the gateway unit).
- **`getProvidersWithKeys`** treats `env:` / `file:` SecretRefs as present when the env var or file resolves, so verify `--test-llm` runs Google API tests when the key is set at runtime.

### Embeddings and OAuth

**Embeddings do not support OAuth.** The embedding path (semantic search, auto-recall, dedup, ingest) always uses one of: **API key** (OpenAI or Google), or **local** (Ollama or ONNX). There is no OAuth-based embedding flow; the plugin does not send embedding requests through the gateway's OAuth. So if you use OAuth only for chat, you still need an embedding setup: either an API key for OpenAI/Google embeddings, or a local provider (Ollama or ONNX) so you can avoid embedding API cost.

---

## How we identify what LLMs are available

The plugin **identifies** available LLMs in two stages: **config** (what you set) and **resolution** (what the code uses at runtime).

### Config sources

| Source | Purpose |
|--------|---------|
| **`llm.nano` / `llm.default` / `llm.heavy`** | Ordered model lists per tier. When set, these are the **only** source for that tier (no legacy key logic). |
| **Legacy keys** (when `llm` is not set) | `embedding.apiKey` (OpenAI), `distill.apiKey` (Google), `claude.apiKey` (Anthropic). The plugin builds tier lists from whichever of these are present and uses built-in default model names per provider. |
| **Gateway merge** | At startup the plugin merges the OpenClaw gateway’s provider config (`models.providers`, etc.) into `llm.providers`. Keys from the gateway are then available for any `provider/model` you list in `llm.nano` / `llm.default` / `llm.heavy`. |
| **Zero-config** | When `llm` is not set, the plugin can derive tiers from OpenClaw’s `agents.defaults.model` (see [Zero-config: auto-derive from OpenClaw](#zero-config-auto-derive-from-openclaw)). |

So “available” means: **any model that appears in the resolved list for a tier and whose provider is usable** — either via an API key (plugin or gateway) or via **OAuth through the gateway** (see [OAuth authentication](#oauth-authentication)). The plugin does **not** call an external “list models” API; it only uses the lists you configure (or the derived lists when `llm` is unset).

### Resolution pipeline (in code)

1. **`getCronModelConfig(cfg)`** — Builds a minimal config slice from full `HybridMemoryConfig`: `embedding`, `distill`, `reflection`, `claude`, `llm`. This is what all tier resolution uses so cron jobs and CLI commands share the same logic.
2. **`getLLMModelPreference(cronCfg, tier)`** — Returns the **ordered list** of model IDs for that tier (`"nano"` | `"default"` | `"heavy"`). If `llm.nano` / `llm.default` / `llm.heavy` are set, that list is used (with optional fallback); otherwise the plugin builds a list from legacy keys or from `agents.defaults.model`. Models whose provider is in **`llm.disabledProviders`** are excluded from this list.
3. **`getDefaultCronModel(cronCfg, tier)`** — Returns the **first** model in the preference list for that tier. Used whenever a single model is needed (e.g. cron job definition, CLI default).
4. **At call time** — The chat/completion path (e.g. `chatCompleteWithRetry`) tries each model in the list in order until one succeeds (or all fail). So “which LLM we use” for a given feature is: **first model in that feature’s tier list that has a key and responds successfully**.

To see which providers the plugin considers configured: **`getProvidersWithKeys(cronCfg)`** (used by verify). To test reachability: **`openclaw hybrid-mem verify --test-llm`**.

---

## How we use them (per feature)

Each LLM-backed feature is assigned a **tier** (nano, default, or heavy). The feature then gets its model(s) as follows:

| Feature | Tier | How the model is chosen |
|---------|------|--------------------------|
| Auto-classify, classify-before-write, query expansion, summarize (recall), reranking, contextual variants, language keywords, retrieval aliases, passive observer | **nano** | `cfg.autoClassify.model` (or equivalent per feature) or `getDefaultCronModel(cronCfg, "nano")`. |
| Reflection, reflect-rules, reflect-meta, **consolidate**, extract-procedures, persona proposals, dream cycle (reflection steps), ingest, cross-agent learning | **default** | Feature-specific config (e.g. `cfg.reflection.model`) or `getDefaultCronModel(cronCfg, "default")`. CLI `--model` overrides when present (e.g. `consolidate --model …`). |
| Distill, self-correction, generate-proposals (heavy path) | **heavy** | `cfg.distill` / selfCorrection config or `getDefaultCronModel(cronCfg, "heavy")`. Distill uses heavy by default; self-correction uses heavy or `selfCorrection.spawnModel`. |

So: **identification** = config + `getCronModelConfig` + `getLLMModelPreference` (and optionally `getProvidersWithKeys`). **Usage** = pick the tier for the feature, then take the first working model from that tier’s list. The full feature–tier matrix is in [FEATURES-AND-TIERS.md](FEATURES-AND-TIERS.md).

---

## Configuring models: `llm` block

Set `llm.nano`, `llm.default`, and `llm.heavy` with ordered model lists. The plugin tries each in order; if one fails (no key, rate limit, 5xx), it tries the next. Model IDs can be **with or without** a provider prefix: `gemini-3.1-pro-preview` and `google/gemini-3.1-pro-preview` are equivalent (the plugin infers `google/` for bare `gemini-*` names so the correct API is used; same for `claude-*` → `anthropic/`, `gpt-*`/`o1` → `openai/`).

**Gateway provider keys:** At startup the plugin merges the gateway’s provider config (e.g. `models.providers` or `llm.providers` in OpenClaw config) into its own `llm.providers`. So any API keys you have in the gateway (Anthropic, Minimax, etc.) are available to the plugin without duplicating them in the plugin config. Add that provider’s models to `llm.default` or `llm.heavy` (e.g. `minimax/your-model`) to use them. Plugin-explicit `llm.providers.<name>` always wins over the gateway merge for that provider.

**OAuth:** For full OAuth setup (no API keys, recommended for many users), see [OAuth authentication](#oauth-authentication) above. You only need `auth.order`, the gateway running, and your model lists.

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

**If your only model is heavy (e.g. Claude Opus):** The plugin detects when the gateway list is heavy-only and **prepends a cheap fallback** (`gpt-4.1-nano`, `gemini-2.5-flash-lite`, `claude-3-5-haiku`) to the default and nano tiers. That way maintenance tasks (classify, summarize, cron job runner, etc.) try a cheaper model first instead of running hundreds of tasks as Opus. Set **`llm.default`** and **`llm.nano`** explicitly in plugin config if you want to override. After upgrading, run **`openclaw hybrid-mem verify --fix`** so stored cron job models are re-resolved from the updated tiers.

**Isolated maintenance crons:** Jobs under `hybrid-mem:*` store a per-job **`model`**. For isolated runs, that model’s **provider family** (the segment before `/`) should match **`agents.defaults.model.primary`**; otherwise the gateway may throw **`LiveSessionModelSwitchError`**. Align them and run **`openclaw hybrid-mem verify --fix`**; **`openclaw hybrid-mem verify`** warns on mismatch. See [SESSION-DISTILLATION.md](SESSION-DISTILLATION.md) and [issue #965](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/965).

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
| `openai` | `https://api.openai.com/v1` | `llm.providers.openai.apiKey`, then `OPENAI_API_KEY` env, then `embedding.apiKey` |
| `anthropic` | `https://api.anthropic.com/v1` | `llm.providers.anthropic.apiKey` (required; no fallback) |
| `minimax` | `https://api.minimax.io/v1` | `llm.providers.minimax.apiKey` or `MINIMAX_API_KEY` env var |

### Azure vs OpenAI keys (no conflict)

To use **both** Azure Foundry and OpenAI (e.g. Azure for embeddings and/or `azure-foundry/*` models, OpenAI for `openai/*` models), set **separate** keys so they do not override each other:

| Use case | Key | When it is used |
|----------|-----|------------------|
| **OpenAI** (api.openai.com, `openai/*` models) | `OPENAI_API_KEY` env or `llm.providers.openai.apiKey` | Chat/completion for `openai/gpt-4.1-nano`, `openai/o3`, etc. |
| **Azure Foundry** (Azure OpenAI / Foundry, `azure-foundry/*` models) | `AZURE_OPENAI_API_KEY` env or `llm.providers["azure-foundry"].apiKey` | Chat/completion and (if configured) embeddings when using Azure endpoint. |

**Precedence:** For the **openai** provider, the plugin uses `OPENAI_API_KEY` (or explicit `llm.providers.openai.apiKey`) **before** `embedding.apiKey`. So you can set `embedding.apiKey` to your Azure key (or use `llm.providers["azure-foundry"]` for embeddings) and `OPENAI_API_KEY` for OpenAI chat — both work without conflict. For **azure-foundry** and **azure-foundry-responses**, the plugin uses `AZURE_OPENAI_API_KEY` when no key is set in `llm.providers`.

In **OpenClaw host** `models.providers["azure-foundry"].apiKey`, use a **SecretRef** such as `env:AZURE_OPENAI_API_KEY` (not a bare env name string), so the gateway resolves the real key instead of sending a literal wrong value.

Example (env only, no keys in config):

```bash
export OPENAI_API_KEY='sk-proj-...'       # OpenAI chat (openai/*)
export AZURE_OPENAI_API_KEY='...'         # Azure Foundry (azure-foundry/*, optional embeddings)
```

Or in config with SecretRefs:

```json
"llm": {
  "providers": {
    "openai":    { "apiKey": "env:OPENAI_API_KEY" },
    "azure-foundry": { "apiKey": "env:AZURE_OPENAI_API_KEY", "baseURL": "https://YOUR_RESOURCE.openai.azure.com/" }
  }
}
```

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
| **Google** | `"google"` | Yes (Google API key) | `text-embedding-004` or `gemini-embedding-001` via Gemini API. Reuses `llm.providers.google.apiKey` or `distill.apiKey`. Not `text-embedding-3-*` (OpenAI). |

**What if I have no provider that supports embeddings?** The plugin **requires** at least one valid embedding configuration to load. If you do not set any embedding provider (or the one you set is invalid — e.g. OpenAI with no key, Ollama not running), the plugin will fail at config parse or startup with a clear error (e.g. missing `embedding.apiKey`, or embedding check failed). You cannot run the plugin with zero embedding access. To avoid paid embedding APIs, use **Ollama** or **ONNX** (local only; no API key).

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

**Azure Foundry (same API as LLM):** To use Azure OpenAI / Foundry for embeddings (e.g. **Azure Foundry Embedding Large** / `text-embedding-3-large`) with the same API key and endpoint as your chat models:

1. **Recommended:** Configure `llm.providers["azure-foundry"]` with `apiKey` and `baseURL` (as you already do for chat). Then set only:
   - `embedding.provider`: `"openai"`
   - `embedding.model`: `"text-embedding-3-large"` (or your Azure embedding deployment name)
   - Do **not** set `embedding.apiKey` or `embedding.endpoint` — the plugin will use the azure-foundry provider for embeddings automatically.

2. **Explicit override:** To point embeddings at a different endpoint (e.g. a dedicated embedding deployment URL), set `embedding.endpoint` to your Azure base URL (e.g. `https://YOUR_RESOURCE.openai.azure.com/openai` or `https://YOUR_RESOURCE.openai.azure.com/openai/deployments/YOUR_EMBEDDING_DEPLOYMENT`) and `embedding.apiKey` to your Azure API key. Use `embedding.model` as the deployment name if using a deployment-style URL.

For Azure, the plugin sends the API key in the `api-key` header and does not append `/v1` when the endpoint already contains `/openai/deployments/`. Set `embedding.dimensions` to `3072` for `text-embedding-3-large`.

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

Uses Google's `gemini-embedding-001` model via the Gemini API's OpenAI-compatible endpoint. Reuses the Google API key from `llm.providers.google.apiKey` (or `distill.apiKey` as a fallback).

```json
"embedding": {
  "provider": "google",
  "model": "gemini-embedding-001",
  "dimensions": 768
},
"llm": {
  "providers": {
    "google": { "apiKey": "AIzaSy..." }
  }
}
```

Default dimensions for `gemini-embedding-001`: 768. Set `embedding.dimensions` explicitly to override.

**Model names:** For `embedding.provider: "google"` the **recommended** models are **`text-embedding-004`** and **`gemini-embedding-001`**. The implementation also recognizes additional Gemini embedding models (including pre-release IDs such as `gemini-embedding-2-preview`) and some legacy/alias names for backward compatibility. Do not configure OpenAI model IDs like `text-embedding-3-small` or `text-embedding-3-large` under the Google provider; the plugin will map these to a Google model and verification may still show the config name — if embedding tests fail, set `embedding.model` explicitly to `gemini-embedding-001` or `text-embedding-004`.

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
