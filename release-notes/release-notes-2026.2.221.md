## 2026.2.221 (2026-02-22)

Patch release: temporary fix for Claude API "tool_use without tool_result" rejection, plus CLI/retry and Sentry fixes from PR #78 (closes #74, #75, #76, #77, #79).

---

### Added

- **Tool-use sanitizer (Claude API):** `sanitizeMessagesForClaude()` utility and `llm_input` hook so every assistant `tool_use` block has a corresponding `tool_result` immediately after. Prevents "LLM request rejected: messages.N: tool_use ids were found without tool_result blocks" when conversation history is trimmed or replayed. Exported from plugin; doc: [TOOL-USE-TOOL-RESULT-ERROR.md](../docs/TOOL-USE-TOOL-RESULT-ERROR.md).
- **Reflect CLI:** `--verbose` flag for `reflect`, `reflect-rules`, and `reflect-meta` (issue #74).
- **Verify UX:** Cron job status and timing (last/next run, error preview); output grouped into logical sections matching `--help` (issues #75, #77).
- **LLM retry and fallback:** `withLLMRetry` and `chatCompleteWithRetry` for distill/ingest, reflection, classification, consolidation, language-keyword generation, embeddings, and summarization; optional fallback models (issue #76).

### Fixed

- **Sentry:** Stop reporting ENOENT on missing `credentials-pending.json` as an error when that path is optional (issue #79).

### Changed

- **Version bump** — Release 2026.02.22 revision (npm `2026.2.221`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

### Upgrade

```bash
openclaw hybrid-mem upgrade 2026.2.221
```

Or from a clean install:

```bash
npx -y openclaw-hybrid-memory-install 2026.2.221
```

Restart the gateway after upgrading.
