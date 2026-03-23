# OpenClaw `models` Configuration (2026.3.x)

Some OpenClaw CLI commands validate `~/.openclaw/openclaw.json` with a **strict schema** that may reject a **top-level `models`** block (error: `models: Unrecognized key: "models"`), even though other tools document `models.providers` for the gateway.

**Workaround:** keep **model provider API keys and routing** in the **memory-hybrid plugin** config instead:

- `plugins.entries["openclaw-hybrid-memory"].config.llm.providers` (and `llm.default` / `llm.heavy` / `llm.nano`)
- Environment: `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, etc.

Do **not** duplicate a full gateway `models.providers` tree at the top level of `openclaw.json` unless your installed OpenClaw version’s schema explicitly allows it (check with `openclaw doctor`).

If you previously merged `models` from another machine’s config, remove the top-level `models` key and keep a backup (e.g. `openclaw.json.bak-before-remove-models-*`).

## `openclaw models` shows only some providers (e.g. no Anthropic)

**`openclaw models` lists models the gateway has registered** (API key or OAuth + model catalog for that provider). It is **not** the same as hybrid-memory’s `llm` tiers.

- If **Anthropic** (or others) are missing, the gateway has **no working Anthropic profile** yet: run **`openclaw configure`** and add **Anthropic** (API key or Claude CLI OAuth), or add Anthropic in whatever provider block your OpenClaw version accepts (see `openclaw doctor`).
- **`ANTHROPIC_API_KEY` in `.env` alone** is often **only** picked up by tools that read env; the gateway may still need an explicit Anthropic setup to show `anthropic/claude-…` under **Configured models**.
- Hybrid-memory can still use Claude if **`plugins.entries["openclaw-hybrid-memory"].config.llm.providers.anthropic`** (or legacy `claude.apiKey`) + key/env are set — verify with **`openclaw hybrid-mem verify --test-llm`**. Agent chat will not offer Anthropic until the gateway lists those models.
