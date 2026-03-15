# Release notes — OpenClaw Hybrid Memory 2026.3.150

**Release date:** 2026-03-15

This release adds **Phase 3 modularization**, **OAuth-first auth with automatic failover**, and clearer **configuration modes**. It builds on the Phase 1 core-only baseline (2026.3.140) and the Phase 2.3 staged lifecycle.

---

## What’s new

### OAuth preferred, with smart failover

When a provider has **both** OAuth (e.g. Claude CLI) and an API key configured, the plugin now **prefers OAuth** by default. If OAuth fails (gateway down, token expired, etc.), it:

1. **Falls back to your API key** so LLM calls keep working.
2. **Records a failure** and waits before trying OAuth again, using an **incremental backoff**: 5 min → 30 min → 1 h → 2 h → 4 h.
3. **Resets backoff** automatically after 24 hours, or you can clear it immediately with:
   ```bash
   openclaw hybrid-mem reset-auth-backoff
   ```

You can turn off OAuth preference with `auth.preferOAuthWhenBoth: false`. See [LLM-AND-PROVIDERS.md](LLM-AND-PROVIDERS.md) for `auth.backoffScheduleMinutes` and `auth.resetBackoffAfterHours`.

### Clearer configuration modes

Configuration **modes** have new names and a single default:

| New name   | Best for              | Notes                                      |
|-----------|------------------------|--------------------------------------------|
| **complete** | Default — full features | Same as previous “full”; everything on.   |
| **enhanced** | Most features, no docs  | No MarkItDown doc ingestion.               |
| **minimal**  | Low cost, nano/flash only | LLM restricted to nano/flash tier.       |
| **local**    | No external LLM        | FTS-only; zero API calls.                  |

- **If you don’t set `mode`**, the default is **`complete`** (backward compatible).
- Old names (`essential`, `normal`, `expert`, `full`) are **mapped** to the closest new mode and a one-time warning is logged. You can update your config to the new names when convenient.

See [CONFIGURATION-MODES.md](CONFIGURATION-MODES.md) and [FEATURES-AND-TIERS.md](FEATURES-AND-TIERS.md).

### New and updated CLI

- **`openclaw hybrid-mem config`** — Shows your effective plugin config and detected mode (or “Custom” if you’ve overridden presets).
- **`openclaw hybrid-mem reset-auth-backoff`** — Clears OAuth failover state so the next LLM call tries OAuth again (for providers with both OAuth and API key).
- **`openclaw hybrid-mem verify --test-llm`** — Runs a minimal completion per provider and reports **OAuth result** and **API result** separately, plus credential source (env, file, plugin, gateway, local). Respects `llm.disabledProviders`.

### Memory-to-skills removed

The **memory-to-skills** feature (`skills-suggest` command, cron job, and related config) has been **removed**. Use **workflow crystallization** and **tool proposals** instead. The number of maintenance cron jobs is reduced from 9 to 8.

### Under the hood

- **Stable internal API** — Optional modules can depend on `MemoryPluginAPI` for tool and lifecycle registration without circular dependencies.
- **Staged lifecycle** — Hooks are split into setup, recall, injection, capture, and cleanup stages with per-stage timeouts and toggles.
- **Procedure injection** — Capped by `procedures.maxInjectionTokens` (default 500); blocks are trimmed to stay within the cap.
- **Fixes** — Credential source fallback in verify, Google base URL for `--test-llm`, and removal of stale `skills-suggest` references.

---

## Upgrade

1. **Pull or install** the plugin at 2026.3.150.
2. **Modes:** If you use deprecated names, you’ll see a one-time warning; set the new names when you edit config. Default remains full-featured (`complete`) when `mode` is omitted.
3. **OAuth + API key:** No change needed; OAuth is preferred and API key is used on failure with backoff. Use `reset-auth-backoff` if you want to retry OAuth immediately.
4. **Memory-to-skills:** Remove `skills-suggest` from cron and config if you used it.

Full changelog: [CHANGELOG.md](../CHANGELOG.md#20263150---2026-03-15).
