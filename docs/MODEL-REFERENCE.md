---

## layout: default
title: Model reference (context, tokens, versions)
parent: Configuration
nav_order: 5

# Model reference — context window, max tokens, versions

This document records **context window**, **max output tokens**, **model version**, and **training data cutoff** for models used with the hybrid-memory plugin. Azure/Foundry data is taken from Microsoft’s documentation (no API returns these fields). Other providers are filled from public docs where available; we extend this as we add or verify models.

**Sources:** [Foundry Models sold directly by Azure](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure?tabs=global-standard-aoai%2Cglobal-standard&pivots=azure-openai) and [Foundry Models from partners and community](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-from-partners) — docs only; the [Models List API](https://learn.microsoft.com/en-us/rest/api/azureopenai/models/list?view=rest-azureopenai-2024-10-21) does **not** return context length or max tokens.

---

## 1. Azure OpenAI (Foundry) — chat/completion

Format: **Context window** | **Max output tokens** | **Training data (up to)**. Where the doc gives separate input/output, both are listed.

### GPT-5.4 series


| Model ID (version)          | Context window                     | Max output tokens | Training data (up to) |
| --------------------------- | ---------------------------------- | ----------------- | --------------------- |
| `gpt-5.4` (2026-03-05)      | 1,050,000                          | 128,000           | August 2025           |
| `gpt-5.4-pro` (2026-03-05)  | 1,050,000                          | 128,000           | August 2025           |
| `gpt-5.4-mini` (2026-03-17) | 400,000 (input 272k / output 128k) | 128,000           | August 2025           |
| `gpt-5.4-nano` (2026-03-17) | 400,000 (input 272k / output 128k) | 128,000           | August 2025           |


### GPT-5.3 series


| Model ID (version)           | Context window                     | Max output tokens | Training data (up to) |
| ---------------------------- | ---------------------------------- | ----------------- | --------------------- |
| `gpt-5.3-codex` (2026-02-24) | 400,000 (input 272k / output 128k) | 128,000           | August 2025           |


### GPT-5.2 series


| Model ID (version)                              | Context window                          | Max output tokens | Training data (up to) |
| ----------------------------------------------- | --------------------------------------- | ----------------- | --------------------- |
| `gpt-5.2-codex` (2026-01-14)                    | 400,000 (input 272k / output 128k)      | 128,000           | —                     |
| `gpt-5.2` (2025-12-11)                          | 400,000 (input 272k / output 128k)      | 128,000           | August 2025           |
| `gpt-5.2-chat` (2025-12-11, 2026-02-10) Preview | 128,000 (input 111,616 / output 16,384) | 16,384            | August 2025           |


### GPT-5.1 series


| Model ID (version)                                                              | Context window                          | Max output tokens | Training data (up to) |
| ------------------------------------------------------------------------------- | --------------------------------------- | ----------------- | --------------------- |
| `gpt-5.1` (2025-11-13)                                                          | 400,000 (input 272k / output 128k)      | 128,000           | September 30, 2024    |
| `gpt-5.1-chat` (2025-11-13) Preview                                             | 128,000 (input 111,616 / output 16,384) | 16,384            | September 30, 2024    |
| `gpt-5.1-codex`, `gpt-5.1-codex-mini`, `gpt-5.1-codex-max` (2025-11-13, -12-04) | 400,000 (input 272k / output 128k)      | 128,000           | September 30, 2024    |


### GPT-5 series


| Model ID (version)                               | Context window                     | Max output tokens | Training data (up to)             |
| ------------------------------------------------ | ---------------------------------- | ----------------- | --------------------------------- |
| `gpt-5`, `gpt-5-mini`, `gpt-5-nano` (2025-08-07) | 400,000 (input 272k / output 128k) | 128,000           | September 30, 2024 / May 31, 2024 |
| `gpt-5-chat` (2025-08-07, 2025-10-03) Preview    | 128,000                            | 16,384            | September 30, 2024                |
| `gpt-5-codex` (2025-09-11)                       | 400,000 (input 272k / output 128k) | 128,000           | —                                 |
| `gpt-5-pro` (2025-10-06)                         | 400,000 (input 272k / output 128k) | 128,000           | September 30, 2024                |


### gpt-oss


| Model ID                 | Context window | Max output tokens | Training data (up to) |
| ------------------------ | -------------- | ----------------- | --------------------- |
| `gpt-oss-120b` (Preview) | 131,072        | 131,072           | May 31, 2024          |
| `gpt-oss-20b` (Preview)  | 131,072        | 131,072           | May 31, 2024          |


### GPT-4.1 series


| Model ID (version)                                     | Context window                                            | Max output tokens | Training data (up to) |
| ------------------------------------------------------ | --------------------------------------------------------- | ----------------- | --------------------- |
| `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano` (2025-04-14) | 1,047,576 (standard/provisioned: 128,000; batch: 300,000) | 32,768            | May 31, 2024          |


### computer-use-preview


| Model ID (version)                  | Context window | Max output tokens | Training data (up to) |
| ----------------------------------- | -------------- | ----------------- | --------------------- |
| `computer-use-preview` (2025-03-11) | 8,192          | 1,024             | October 2023          |


### o-series (reasoning)


| Model ID (version)        | Max request (input / output)     | Training data (up to) |
| ------------------------- | -------------------------------- | --------------------- |
| `codex-mini` (2025-05-16) | Input: 200,000 / Output: 100,000 | May 31, 2024          |
| `o3-pro` (2025-06-10)     | Input: 200,000 / Output: 100,000 | May 31, 2024          |
| `o4-mini` (2025-04-16)    | Input: 200,000 / Output: 100,000 | May 31, 2024          |
| `o3` (2025-04-16)         | Input: 200,000 / Output: 100,000 | May 31, 2024          |
| `o3-mini` (2025-01-31)    | Input: 200,000 / Output: 100,000 | October 2023          |
| `o1` (2024-12-17)         | Input: 200,000 / Output: 100,000 | October 2023          |
| `o1-preview` (2024-09-12) | Input: 128,000 / Output: 32,768  | October 2023          |
| `o1-mini` (2024-09-12)    | Input: 128,000 / Output: 65,536  | October 2023          |


### GPT-4o and GPT-4 Turbo


| Model ID (version)                            | Max request (input / output)                           | Training data (up to) |
| --------------------------------------------- | ------------------------------------------------------ | --------------------- |
| `gpt-4o` (2024-11-20, 2024-08-06, 2024-05-13) | Input: 128,000 / Output: 16,384 (4,096 for 2024-05-13) | October 2023          |
| `gpt-4o-mini` (2024-07-18)                    | Input: 128,000 / Output: 16,384                        | October 2023          |
| `gpt-4` (turbo-2024-04-09)                    | Input: 128,000 / Output: 4,096                         | December 2023         |


### Model router (Azure)


| Model ID                                            | Context window | Max output tokens                                                 | Notes                                                                                           |
| --------------------------------------------------- | -------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `model-router` (2025-11-18, 2025-08-07, 2025-05-19) | 200,000        | Varies by routed model (e.g. 32,768 / 100,000 / 128,000 / 16,384) | Routes to underlying models; larger context only works when routed to a model that supports it. |


---

## 2. Azure OpenAI — embeddings


| Model ID (version)            | Max request (tokens) | Output dimensions | Training data (up to) |
| ----------------------------- | -------------------- | ----------------- | --------------------- |
| `text-embedding-ada-002` (v1) | 2,046                | 1,536             | Sep 2021              |
| `text-embedding-ada-002` (v2) | 8,192                | 1,536             | Sep 2021              |
| `text-embedding-3-small`      | 8,192                | 1,536             | Sep 2021              |
| `text-embedding-3-large`      | 8,192                | 3,072             | Sep 2021              |


Max items per embedding request (array of inputs): 2,048.

---

## 3. Other Foundry models sold by Azure (summary)

Capabilities and token limits from the [Other model collections](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure?pivots=azure-direct-others) tab.


| Provider  | Model                                                  | Input (tokens)                 | Output (tokens)          | Notes                             |
| --------- | ------------------------------------------------------ | ------------------------------ | ------------------------ | --------------------------------- |
| Cohere    | `Cohere-command-a`                                     | 131,072                        | 8,182                    | Chat. Tool calling.               |
| Cohere    | `embed-v-4-0`                                          | 512 (text), 2M pixels (images) | Vector 256/512/1024/1536 | Embeddings.                       |
| DeepSeek  | `DeepSeek-V3.2`, `DeepSeek-V3.2-Speciale`              | 128,000                        | 128,000                  | Reasoning content.                |
| DeepSeek  | `DeepSeek-V3.1`                                        | 131,072                        | 131,072                  | Tool calling.                     |
| DeepSeek  | `DeepSeek-R1`, `DeepSeek-R1-0528`                      | 163,840                        | 163,840                  | Reasoning.                        |
| DeepSeek  | `DeepSeek-V3-0324`                                     | 131,072                        | 131,072                  | Tool calling.                     |
| Meta      | `Llama-4-Maverick-17B-128E-Instruct-FP8`               | 1M (text + images)             | 1M                       | Multimodal.                       |
| Meta      | `Llama-3.3-70B-Instruct`                               | 128,000                        | 8,192                    | Chat.                             |
| Microsoft | `MAI-DS-R1`                                            | 163,840                        | 163,840                  | Reasoning.                        |
| Mistral   | `Mistral-Large-3`                                      | —                              | —                        | Chat, tool calling, text + image. |
| Mistral   | `mistral-document-ai-2512`, `mistral-document-ai-2505` | 30 pages PDF / image           | Text                     | Document AI.                      |
| Moonshot  | `Kimi-K2.5`, `Kimi-K2-Thinking`                        | 262,144                        | 262,144                  | Reasoning.                        |
| xAI       | `grok-4`, `grok-4.1-fast-`*, etc.                      | 128,000–262,000                | 8,192–128,000            | See Azure doc for per-model.      |


---

## 4. Foundry models from partners and community

Models from [Foundry Models from partners and community](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-from-partners). These are third-party models deployable in Foundry (often via Azure Marketplace); availability and billing depend on the provider and your subscription region.

### Anthropic (via Foundry)

When using Claude **through Azure Foundry** (Marketplace), these specs apply. Preview; requires paid Azure subscription and region where Anthropic offers the offer.


| Model                         | Context window | Max output | Notes                                   |
| ----------------------------- | -------------- | ---------- | --------------------------------------- |
| `claude-opus-4-6` (Preview)   | 1,000,000      | 128,000    | Text, image, code in/out. Tool calling. |
| `claude-sonnet-4-6` (Preview) | 1,000,000      | 128,000    | Text, image, code in/out. Tool calling. |
| `claude-opus-4-5` (Preview)   | 200,000        | 64,000     | Text, image, code.                      |
| `claude-opus-4-1` (Preview)   | 200,000        | 32,000     | Text, image, code.                      |
| `claude-sonnet-4-5` (Preview) | 200,000        | 64,000     | Text, image, code.                      |
| `claude-haiku-4-5` (Preview)  | 200,000        | 64,000     | Text, image. Tool calling.              |


### Cohere (partners)


| Model                           | Input (tokens) | Output (tokens)  | Type                      |
| ------------------------------- | -------------- | ---------------- | ------------------------- |
| `Cohere-command-r-plus-08-2024` | 131,072        | 4,096            | Chat, tool calling.       |
| `Cohere-command-r-08-2024`      | 131,072        | 4,096            | Chat, tool calling.       |
| `Cohere-embed-v3-english`       | 512            | Vector 1024 dim. | Embeddings, English.      |
| `Cohere-embed-v3-multilingual`  | 512            | Vector 1024 dim. | Embeddings, multilingual. |


### Meta (partners)


| Model                            | Input (tokens)         | Output (tokens) | Notes   |
| -------------------------------- | ---------------------- | --------------- | ------- |
| `Llama-3.2-11B-Vision-Instruct`  | 128,000 (text + image) | 8,192           | Vision. |
| `Llama-3.2-90B-Vision-Instruct`  | 128,000 (text + image) | 8,192           | Vision. |
| `Meta-Llama-3.1-405B-Instruct`   | 131,072                | 8,192           | Text.   |
| `Meta-Llama-3.1-8B-Instruct`     | 131,072                | 8,192           | Text.   |
| `Llama-4-Scout-17B-16E-Instruct` | 128,000 (text + image) | 8,192           | Vision. |


### Microsoft (partners — Phi)


| Model                       | Input (tokens)                | Output (tokens) | Notes              |
| --------------------------- | ----------------------------- | --------------- | ------------------ |
| `Phi-4-mini-instruct`       | 131,072                       | 4,096           | Multilingual.      |
| `Phi-4-multimodal-instruct` | 131,072 (text, images, audio) | 4,096           | Multimodal.        |
| `Phi-4`                     | 16,384                        | 16,384          | Text.              |
| `Phi-4-reasoning`           | 32,768                        | 32,768          | Reasoning content. |
| `Phi-4-mini-reasoning`      | 128,000                       | 128,000         | Reasoning content. |


### Mistral AI (partners)


| Model                 | Input (tokens)    | Output (tokens) | Notes         |
| --------------------- | ----------------- | --------------- | ------------- |
| `Codestral-2501`      | 262,144           | 4,096           | Code.         |
| `Ministral-3B`        | 131,072           | 4,096           | Tool calling. |
| `Mistral-small-2503`  | 32,768            | 4,096           | Tool calling. |
| `Mistral-medium-2505` | 128,000 (+ image) | 128,000         | Multimodal.   |


### Stability AI (partners)

Image generation only: `Stable Diffusion 3.5 Large` (text + image in), `Stable Image Core`, `Stable Image Ultra` (text in). See [Foundry Models from partners](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-from-partners#stability-ai) for details.

---

## 5. Other providers (used with hybrid-memory)

Models commonly used in `llm.nano` / `llm.default` / `llm.heavy`. Version and training data are from public provider docs; we update as we verify.

### Anthropic Claude

When using Claude via **Anthropic API** (not Azure Foundry). For **Foundry/Marketplace** deployment, see [§4 Foundry models from partners](#4-foundry-models-from-partners-and-community) (e.g. 1M context, 128k output for opus-4-6 / sonnet-4-6).


| Model ID            | Context window (approx)     | Max output (approx) | Notes                 |
| ------------------- | --------------------------- | ------------------- | --------------------- |
| `claude-haiku-4-5`  | 200k                        | 64k                 | Nano tier.            |
| `claude-sonnet-4-6` | 200k (up to 1M via Foundry) | 8k–128k             | Default tier.         |
| `claude-opus-4-6`   | 200k (up to 1M via Foundry) | 8k–128k             | Heavy tier.           |
| `claude-3-5-haiku`  | 200k                        | 8k                  | Legacy nano fallback. |


*Check [Anthropic model docs](https://docs.anthropic.com/en/docs/about-claude/models) for current versions and training cutoffs.*

### Google Gemini


| Model ID                 | Context window (approx) | Max output (approx) | Notes                            |
| ------------------------ | ----------------------- | ------------------- | -------------------------------- |
| `gemini-2.5-flash-lite`  | 1M                      | 8k                  | Nano / fallback.                 |
| `gemini-2.5-flash`       | 1M                      | 8k                  | Default tier.                    |
| `gemini-3.1-pro-preview` | 1024k                   | 8k                  | Heavy; long context for distill. |
| `gemini-2.0-flash-lite`  | —                       | —                   | Deprecated; use 2.5-flash-lite.  |


*Check [Google AI model specs](https://ai.google.dev/gemini-api/docs/models) for versions and training data.*

### MiniMax


| Model ID       | Context / output  | Notes                 |
| -------------- | ----------------- | --------------------- |
| `MiniMax-M2.5` | See provider docs | Used in nano/default. |


### OpenAI (direct, non-Azure)

When using `openai` provider with `api.openai.com` (not Azure), same model names apply; limits align with Azure where the model is the same. See Azure tables above for `gpt-4.1`, `gpt-4o`, `o3`, etc.

### Ollama / local


| Model ID (example)             | Context / output | Notes                               |
| ------------------------------ | ---------------- | ----------------------------------- |
| `qwen3:8b`                     | Depends on run   | Local; thinking mode supported.     |
| Other (Llama, Mistral, Phi, …) | Varies           | No central doc; set per deployment. |


---

## 6. How we use this in the plugin

- **Tier choice:** [LLM-AND-PROVIDERS.md](LLM-AND-PROVIDERS.md) and [FEATURES-AND-TIERS.md](FEATURES-AND-TIERS.md) recommend models by tier (nano / default / heavy). Use this reference to check context and max output when you need long context (e.g. distillation → heavy with 200k+ or 1M context).
- **Config:** OpenClaw gateway or plugin can set per-model `contextWindow` and `maxTokens` in provider/model config; this doc is the source of truth for Azure where the API does not expose them.
- **Plugin catalog:** The memory-hybrid plugin uses `extensions/memory-hybrid/services/model-capabilities.ts` for `distillBatchTokenLimit` and `distillMaxOutputTokens` (and optionally `getContextWindow`). That catalog is kept in sync with this doc; add new models there when you add them here.
- **Embeddings:** When switching embedding model (e.g. `text-embedding-3-small` → `text-embedding-3-large`), dimensions change (1,536 → 3,072); re-embed and re-index. See [Embedding providers](LLM-AND-PROVIDERS.md#embedding-providers) and config for `embedding.dimensions`.

---

## 7. Changelog for this doc


| Date       | Change                                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-03-19 | Initial version: Azure OpenAI (GPT-5.4–4, o-series, 4.1, 4o, embeddings), other Foundry providers summary, Anthropic/Google/MiniMax/Ollama placeholders.                                                                                                     |
| 2026-03-19 | Added Foundry models from partners and community: Anthropic (Foundry), Cohere, Meta, Microsoft (Phi), Mistral AI, Stability AI; source [models-from-partners](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-from-partners). |
| 2026-03-19 | Plugin: added `services/model-capabilities.ts` with per-model context window, max output tokens, and batch token limit for distill; `chat.ts` now uses it for `distillBatchTokenLimit` and `distillMaxOutputTokens`. Deploy: added `openclaw.model-tokens-snippet.json` for OpenClaw config. |
| 2026-03-20 | Google: default nano/fallback model switched from deprecated `gemini-2.0-flash-lite` (404) to `gemini-2.5-flash-lite`. See [Gemini deprecations](https://ai.google.dev/gemini-api/docs/deprecations). |


