## 2026.3.100 — Stability & Hardening Release (2026-03-10)

**The biggest stability release since launch.** 13 bug fixes from GlitchTip error reports, LanceDB OOM crash resolution, full provider hardening, and a 4-model council review (GPT-5.4, Claude Opus, Gemini Pro, Claude Sonnet) with all 76 review threads resolved.

---

### 🚨 Critical Fixes

#### LanceDB OOM Crashes Resolved (#292)
The vector database was crashing every ~6 hours with out-of-memory errors. Root cause: `table.optimize()` was never called, leading to **9,036 uncompacted fragments** and **2.7 GB of stale version files**. 

**Fix:** New `VectorDB.optimize()` method with automatic compaction every 100 stores. Emergency compaction freed 2.6 GB immediately. Weekly cron job keeps it clean going forward.

```bash
# Manual compaction if needed
openclaw hybrid-mem optimize
```

#### Gateway Token Leak (Security)
The internal gateway authentication token was included in the OpenAI provider fallback chain. If a custom external `baseURL` was configured, the token could be sent to third-party endpoints. **Now removed from the fallback chain entirely.**

---

### 🛡️ Provider Hardening

All LLM and embedding provider interactions are now resilient to real-world failure modes:

| Issue | Problem | Fix |
|-------|---------|-----|
| **#294** | `UnconfiguredProviderError` with no fallbacks | Resolves OpenRouter, Anthropic, and generic API keys |
| **#295** | 401 invalid keys cause infinite retries | Fast-fail on auth errors, skip to next provider |
| **#296** | 429 rate limits not handled | `Retry-After` header parsing + exponential backoff |
| **#297** | Ollama embedding exceeds context length | Input truncation at `MAX_INPUT_CHARS` |
| **#298** | Ollama connection failures cascade | Per-URL circuit breaker (not global) |
| **#299** | `$HOME` not expanded in file paths | Explicit expansion in `plugin-service.ts` |
| **#300** | All embedding providers fail silently | Graceful degradation — store facts without embeddings |
| **#301** | LLM request timeouts unhandled | Transient error retry with configurable limits |
| **#302** | LLM 500 errors not handled | 5xx treated as transient, targeted retry limit |
| **#303** | LLM 404 (model not found) fails silently | `is404Like` detection, skip to next model |

---

### ⚡ Incremental Processing (#288)

All scan operations now use **watermark-based cursors** stored in a `scan_cursors` SQLite table. On each run, only sessions created since the last successful scan are processed.

- `extract-procedures`, `extract-directives`, `extract-reinforcement`, `distill`, `self-correction-run` — all incremental
- `--full` flag forces a complete re-scan
- `--dry-run` flag previews without writing cursors
- 23-hour rate-limit guard prevents double-execution

**Impact:** Nightly jobs that previously scanned your entire session history now complete in seconds.

---

### 🕐 Cron Job Guards (#304, #305)

Plugin cron jobs were re-firing on every gateway restart because `lastRun` state wasn't preserved.

**Fix:** Guard prefix system using `/tmp/hybrid-mem-guard-<job>.txt` timestamp files with three interval tiers:
- **Daily jobs:** 20-hour minimum interval
- **Weekly jobs:** 5-day minimum interval  
- **Monthly jobs:** 25-day minimum interval

---

### 💰 Cost Optimization

Background features now default to **nano-tier models** (e.g., `gpt-4.1-nano`):
- `autoClassify`, `HyDE`, `queryExpansion`, `classifyBeforeWrite`, `summarize` → nano tier
- `selfCorrection.spawnModel` → Sonnet (was using agent's primary model)
- `distill.extractionModelTier` → Flash (was heavy)
- Expensive `implicitFeedback` paths disabled by default

**Estimated impact:** Background LLM costs reduced by ~80-90% for typical workloads.

---

### 📊 By the Numbers

- **13 bugs fixed** from GlitchTip production error reports
- **76 review threads** resolved from 4-model council review
- **2,834 tests** passing (116 test files)
- **12 GitHub issues** closed (#288, #292, #294–#304)
- **2.6 GB** freed from LanceDB compaction
- **9,036 → 1** vector DB fragments after optimize

---

### Upgrade

```bash
openclaw hybrid-mem upgrade 2026.3.100
```

Or via npm:
```bash
npx -y openclaw-hybrid-memory-install 2026.3.100
```

After upgrade, restart the gateway:
```bash
openclaw gateway restart
```

**Recommended:** Run compaction after upgrade if you haven't recently:
```bash
openclaw hybrid-mem optimize
```

---

### Breaking Changes

None. All changes are backward-compatible.

### Known Issues

- OpenAI nano/mini models may return 401 if `llm.providers.openai.apiKey` is not set in plugin config. The plugin falls back to routing through the local gateway, which requires `OPENCLAW_GATEWAY_TOKEN`. **Workaround:** Add `llm.providers.openai.apiKey` to your plugin config pointing to your OpenAI API key.
