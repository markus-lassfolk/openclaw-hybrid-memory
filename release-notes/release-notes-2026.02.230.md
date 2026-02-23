## 2026.02.230 (2026-02-23)

Feature and fix release: multi-provider LLM proxy (nano/default/heavy tiers), embeddings direct to OpenAI, error-reporting bot identity, config/model fallbacks, stats and distill improvements, and PR #93 review fixes (fixes #91, #92, #94, #95).

---

### Added

- **Multi-provider LLM proxy** — Configurable `llm.nano`, `llm.default`, and `llm.heavy` with ordered model lists and per-provider API keys. Chat/completion uses the gateway or direct provider APIs by tier: **nano** for cheap ops (autoClassify, HyDE, classifyBeforeWrite), **default** for reflection and language-keywords, **heavy** for distillation and persona proposals. See [LLM-AND-PROVIDERS.md](../docs/LLM-AND-PROVIDERS.md).
- **Error reporting bot identity** — Optional `errorReporting.botId` and `errorReporting.botName` for GlitchTip/Sentry tags so you can group and filter errors by bot; config-set and [ERROR-REPORTING.md](../docs/ERROR-REPORTING.md) updated.
- **Stats** — Real queries for reflection, self-correction, language-keywords, and tier counts (no placeholder zeros).
- **Distill** — Chunking for oversized sessions: when a session exceeds `--max-session-tokens`, it is split into overlapping windows instead of truncated; each chunk is tagged and dedup handles cross-chunk duplicates.

### Fixed

- **Embeddings** — Requests go direct to OpenAI; the gateway is no longer used for `/v1/embeddings` (fixes GlitchTip #11 405 errors, #91).
- **HyDE and cron fallbacks** — HyDE uses `llm.default`; all runtime model fallbacks use `getDefaultCronModel()` with no hardcoded gpt-4o/gpt-4o-mini (#92).
- **Config** — `getDefaultCronModel()` fallbacks for all model fields; valid OpenAI model IDs when only embedding is configured (#94).
- **Error reporting** — Schema accepts `botId`/`botName`; no hostname leak when `botId` is not set (#95).
- **Crashes** — Missing `pendingLLMWarnings` causing crash; gateway baseURL routing for chat OpenAI client restored.
- **Model/config** — Encryption key validation, timeout cleanup, model tier costs, HyDE fallback; UnconfiguredProviderError detection; model tier for auto-classify; OpenAI client cache key; credentials encryption validation.
- **Proposals** — Stronger proposal-generation prompt (template awareness, identity scoping, additive-first); improved error logging.
- **Deploy snippet** — Removed hardcoded models.

### Changed

- **Docs** — [LLM-AND-PROVIDERS.md](../docs/LLM-AND-PROVIDERS.md) and related docs aligned with multi-provider proxy and three-tier architecture; [ERROR-REPORTING.md](../docs/ERROR-REPORTING.md) for bot identity and config-set; [TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md) expanded.

---

### Upgrade

```bash
openclaw hybrid-mem upgrade 2026.02.230
```

Or from a clean install:

```bash
npx -y openclaw-hybrid-memory-install 2026.02.230
```

Restart the gateway after upgrading.
