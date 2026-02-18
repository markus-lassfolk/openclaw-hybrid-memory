## 2026.2.176 (2026-02-17)

### Added

**Gemini support for distill** — `openclaw hybrid-mem distill` can now use Google Gemini. Pass `--model gemini-2.0-flash` (or set `distill.defaultModel` in config). Configure `distill.apiKey` or use `GOOGLE_API_KEY` / `GEMINI_API_KEY` env vars. Gemini's 1M+ context allows larger batches (500k tokens vs 80k for OpenAI), so you can process more sessions per run.

**Distill: chunk oversized sessions** — Sessions exceeding `--max-session-tokens` are split into overlapping windows (10% overlap) instead of truncated. Each chunk is tagged `SESSION: <file> (chunk N/M)`. Dedup handles cross-chunk duplicates.

### Changed

- **Documentation:** CONFIGURATION (distill.apiKey, distill.defaultModel), SESSION-DISTILLATION (--model, Gemini setup), CLI-REFERENCE (distill --model and batch sizes).
- **Tests:** chat.test.ts, distill config tests, distill-chunk.test.ts.
