# Model-agnostic support: analysis and options

The hybrid-memory plugin currently hardcodes **OpenAI** for embeddings and chat (classify, consolidate, summarize), and **Gemini** is recommended in docs/scripts for session distillation. This document analyzes how much work it would take to support **OpenAI, Gemini, and Claude** (or any combination) in a cleaner way.

**Decision (as of 2026.2.16):** We are **not** implementing model-agnostic setup for now. Keep the current hardcoded models (OpenAI for embeddings and chat; Gemini in docs/scripts for distillation). The options below remain for future reference.

---

## Current hardcoding

| Area | What’s hardcoded | Where |
|------|------------------|--------|
| **Embeddings** | OpenAI only: `OpenAI` client, `embeddings.create()`, `provider: "openai"`, model names `text-embedding-3-small` / `text-embedding-3-large`, dimensions 1536/3072 | `config.ts` (schema, defaults, `vectorDimsForModel`), `index.ts` (class `Embeddings`, `new OpenAI()`) |
| **Chat (LLM)** | Single OpenAI client for: auto-classify, consolidate (merge step), summarize-when-over-budget. Model strings like `gpt-4o-mini`, `gpt-4.1-nano` | `index.ts` (`openaiClient.chat.completions.create`), `config.ts` (autoClassify.model, summarizeModel), defaults in verify/install |
| **Distillation** | Docs and scripts say “use Gemini”, cron suggests `model: "gemini"`. Runtime is already model-agnostic (`openclaw sessions spawn --model <any>`) | `SESSION-DISTILLATION.md`, `scripts/distill-sessions/*`, `SETUP-AUTONOMOUS.md`, install/cron snippets |

So: **embeddings and in-plugin chat are OpenAI-only**; **distillation** is doc-level Gemini bias but the pipeline accepts any model.

---

## What “model-agnostic” could mean

1. **Embeddings:** User can choose **OpenAI**, **Google (Gemini)**, or another provider; each has its own API key and model list; dimensions stay correct per model.
2. **Chat (classify / consolidate / summarize):** User can choose **OpenAI**, **Anthropic (Claude)**, or **Google (Gemini)** for these features, with the right API key and model id.
3. **Distillation:** Keep runtime agnostic; docs and examples should say “use any long-context model (e.g. Gemini, Claude, GPT)” and avoid a single hardcoded default.

---

## Option A: Minimal (docs + config only)

**Scope:** No new code paths. Make wording and suggested config model-agnostic.

- **Distillation:** Replace “use Gemini” with “use any long-context model (Gemini, Claude, GPT); Gemini recommended for 1M context”. Suggested cron/job: `model: "<your long-context model>"` or keep `gemini` as one example among others.
- **Chat:** In config schema and docs, describe `autoClassify.model` and `summarizeModel` as “any chat model id your provider supports (e.g. openai/gpt-4o-mini, anthropic/claude-3-haiku, google/gemini-2.0-flash)” — **only if** OpenClaw already resolves these model ids when the plugin calls something. If the plugin today only has an OpenAI client, then changing docs alone doesn’t actually allow Claude/Gemini for classify/consolidate/summarize; we’d only be documenting a future or external behavior.

**Effort:** Small (a few doc/comment edits). **Outcome:** Distillation is clearly “any model”; plugin behaviour for embeddings and chat stays OpenAI-only unless we add code.

---

## Option B: Chat (and embeddings) via OpenClaw — exploration result

**Scope:** Use OpenClaw’s existing model routing for chat (and optionally embeddings) so the plugin doesn’t manage providers or API keys.

**Exploration (OpenClaw plugin SDK, as of 2026.2.14):**

- **`OpenClawPluginApi`** (the object passed to `register(api)`) exposes: `id`, `name`, `config`, `pluginConfig`, `runtime`, `logger`, `registerTool`, `registerHook`, `registerHttpHandler`, `registerHttpRoute`, `registerChannel`, `registerGatewayMethod`, `registerCli`, `registerService`, `registerProvider`, `registerCommand`, `resolvePath`, `on` (lifecycle hooks). There is **no** `invokeChat`, `createCompletion`, `embed`, or similar method.
- **`api.runtime`** (PluginRuntime) exposes: `config`, `system`, `media`, `tts`, `tools` (e.g. `createMemoryGetTool`, `createMemorySearchTool`, `registerMemoryCli`), `channel` (routing, reply, discord/slack/telegram/etc.), `logging`, `state`. Again **no** model-invocation or embedding API.
- OpenClaw **internally** has embedding clients (OpenAI, Gemini, Voyage) and chat/completion flows, but these are not part of the plugin API surface.

**Conclusion:** Option B is **not available** with the current SDK. Plugins cannot call OpenClaw’s chat or embedding APIs; they must use their own clients and keys. To use Option B in the future, OpenClaw would need to add something like:
- `api.invokeChat(modelId: string, messages: Array<{role, content}>, options?)` → completion text or stream
- and/or `api.embed(modelId: string, text: string)` (or batch) → `number[]`

**Recommendation:** If you want model-agnostic behaviour without maintaining multiple SDKs in the plugin, consider opening a feature request or PR on the OpenClaw repo for a plugin-callable model/embed API. Until then, use **Option C** (multi-provider inside the plugin).

---

## Option C: Multi-provider in the plugin (embeddings + chat)

**Scope:** Plugin owns provider selection and (optionally) multiple API keys.

### Embeddings

- **Config:** e.g. `embedding: { provider: "openai" | "google", apiKey: string, model: string }`. Optional: `baseURL` for OpenAI-compatible endpoints.
- **Implementation:**
  - **OpenAI:** Keep current `Embeddings` class (OpenAI client, `embeddings.create`).
  - **Google:** Gemini offers an [OpenAI-compatible embedding endpoint](https://ai.google.dev/gemini-api/docs/openai). Use the same OpenAI SDK with `baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"`, `apiKey: GOOGLE_API_KEY`, model e.g. `text-embedding-004` or `gemini-embedding-001`. Add dimensions (e.g. 768 for text-embedding-004) to `vectorDimsForModel`.
  - **Anthropic:** No native embedding API; they recommend Voyage. So “Claude” for embeddings could mean “use Voyage” (separate key) or we only support OpenAI + Google for embeddings and document that.
- **Code:** One interface `embed(text: string): Promise<number[]>`; factory that returns OpenAI or Google (and optionally Voyage) implementation based on `provider`. Same `vectorDimsForModel` lookup for all.

**Effort:** Medium (config schema, factory, one new adapter, dimension map, verify/--fix messages). **Rough size:** on the order of 100–150 lines.

### Chat (classify, consolidate, summarize)

- **Config:** e.g. `chat: { provider: "openai" | "anthropic" | "google", apiKey?: string, model: string }`. If no key, could later plug into OpenClaw auth (Option B).
- **Implementation:** Thin adapters that all expose the same shape: `createCompletion(messages, options) -> content string`.
  - **OpenAI:** existing `openai.chat.completions.create`.
  - **Anthropic:** `@anthropic-ai/sdk`, `messages.create()`; map to same request/response shape.
  - **Google:** Gemini chat can be called via REST or SDK; map to same shape.
- **Code:** Replace direct `openaiClient` usage in `classifyBatch`, `runConsolidate` (merge step), and summarize-when-over-budget with a call to the chosen chat adapter. One adapter per provider, selected from config.

**Effort:** Medium (config, 2–3 adapters, wire into 3 features, error messages). **Rough size:** 150–250 lines including types and errors.

### Total for Option C

- **Embeddings:** medium (OpenAI + Google; Voyage optional).
- **Chat:** medium (OpenAI + Anthropic + Google).
- **Docs/config:** update schema, CREDENTIALS/README/SETUP-AUTONOMOUS, verify/--fix copy.
- **Overall:** moderate feature work, no change to core memory or storage; mainly new config and adapter layer.

---

## Option D: OpenClaw as single source of truth (ideal long term)

**Scope:** Embeddings and chat both go through OpenClaw (or a shared gateway) so the plugin never holds API keys or provider logic.

- Embeddings: e.g. `api.embed(modelId, text)` that uses OpenClaw’s embedding config and routing.
- Chat: as in Option B, `api.invokeChat(modelId, messages)`.

Then the plugin only stores **model ids** (e.g. `openai/text-embedding-3-small`, `google/gemini-embedding-001`, `openai/gpt-4o-mini`, `anthropic/claude-3-haiku`). Users configure providers and keys in OpenClaw once; the plugin stays model-agnostic.

**Effort:** Depends entirely on OpenClaw exposing these APIs. If they do: plugin change is similar to Option B + embedding entry point. If they don’t: not feasible without upstream work.

---

## Recommendation

- **Short term (low effort):**
  - **Distillation:** Treat as model-agnostic in docs and scripts (Option A): “use any long-context model (e.g. Gemini, Claude, GPT); Gemini recommended for 1M context,” and avoid a single hardcoded default where possible.
  - **Chat/embedding:** If the plugin SDK already exposes a chat (and optionally embedding) API, prefer **Option B** (and D for embeddings if available) so the plugin doesn’t hardcode providers.

- **If the plugin must remain self-contained:**
  - **Option C** is the way to support “any combination of OpenAI, Gemini, Claude”:
    - **Embeddings:** Add `provider` + Google (OpenAI-compatible endpoint); document that Claude doesn’t provide embeddings (optionally add Voyage).
    - **Chat:** Add `chat.provider` and adapters for OpenAI, Anthropic, Google; wire classify, consolidate, and summarize to the chosen adapter.
  - **Effort:** on the order of **2–4 days** for a solid implementation (config, adapters, tests, docs, verify/install defaults).

- **Dimension handling:** Each embedding model has a fixed dimension (OpenAI 1536/3072, Gemini 768 or per-model, Voyage 1024). The plugin already has `vectorDimsForModel`; we’d extend it with a map for each supported model id so LanceDB and similarity logic stay correct.

---

## Summary table

| Area | Current | Option A | Option B | Option C |
|------|--------|----------|----------|----------|
| Distillation | Docs say Gemini | Docs say “any model” | Same | Same |
| Embeddings | OpenAI only | No change | Use OpenClaw if exists | OpenAI + Google (+ optional Voyage) in plugin |
| Chat (classify etc.) | OpenAI only | No change | Use OpenClaw if exists | OpenAI + Anthropic + Google in plugin |
| Effort | — | Small | Small–medium (if API exists) | Medium (2–4 days) |

If you want to proceed with Option C later, the next step is to add `embedding.provider` and the Google embedding path (and optionally `chat.provider` plus one extra chat adapter), then iterate. For now we keep hardcoded models.

---

## Related docs

- [README](../README.md) — Project overview and all docs
- [CONFIGURATION.md](CONFIGURATION.md) — Current config reference (OpenAI-only)
- [ARCHITECTURE.md](ARCHITECTURE.md) — System architecture overview
