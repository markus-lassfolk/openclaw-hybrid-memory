## 2026.3.110 — Qwen3 / Ollama Thinking Mode Fix (2026-03-11)

Fixes cron agents and background jobs that use **Qwen3** (and other thinking-mode models) via Ollama: they no longer time out with empty responses.

---

### What changed

#### Qwen3 and thinking-mode models now return full responses (#314)

**Problem:** When you use **Qwen3** (e.g. `ollama/qwen3:8b` or `ollama/qwen3:32b`) for cron jobs such as session distillation, self-correction, or reflection, the agent often appeared to “do nothing” or time out. The model was actually replying, but Ollama’s thinking mode puts the answer in a different field:

- **Standard:** `message.content` is empty.
- **Actual reply:** In `message.reasoning_content` (or the older `message.reasoning` field).

The plugin only read `message.content`, so it saw an empty reply and treated the call as failed or timed out.

**Fix:** The chat completion helper now checks **all** of these when `content` is empty:

- `message.reasoning_content` (current Ollama/OpenAI-style field)
- `message.reasoning` (legacy field)

So cron agents and any code using the shared chat path now get the full model output for Qwen3 and other thinking-mode models. **Non–thinking-mode models are unchanged.**

---

### Who should upgrade

- You use **Ollama** with **Qwen3** (or any model that uses thinking/reasoning and leaves `content` empty) for:
  - Nightly or scheduled agents
  - Session distillation
  - Self-correction
  - Reflection or other background LLM tasks
- You’ve seen timeouts or “empty” responses from those jobs even though the model is working in the Ollama UI or elsewhere.

If you only use cloud APIs (OpenAI, Anthropic, Google, etc.) or non-thinking Ollama models, behavior is unchanged; upgrading is still recommended for consistency.

---

### Upgrade

```bash
openclaw hybrid-mem upgrade 2026.3.110
```

Or install this version directly:

```bash
npx -y openclaw-hybrid-memory-install 2026.3.110
```

Then restart the gateway:

```bash
openclaw gateway stop
openclaw gateway start
```

---

### Breaking changes

None. Fully backward-compatible with 2026.3.100.

### Known issues

Same as 2026.3.100: if you use OpenAI nano/mini and get 401s, set `llm.providers.openai.apiKey` in your plugin config (see [release-notes-2026.3.100.md](release-notes-2026.3.100.md)).
