# Release Notes — OpenClaw Hybrid Memory 2026.3.301

**Date:** 2026-03-30

## Summary

Version **2026.3.301** follows **2026.3.300** with:

- **Embeddings ([#932](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/932), [#934](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/934)):** Azure deployment names and verify CLI embedding tests stay aligned with `createEmbeddingProvider` behavior.
- **Narratives / chat ([#935](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/935), [#936](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/936)):** Longer timeout for daily narrative LLM calls; `chatCompleteWithRetry` treats `LLMRetryError`-wrapped abort/timeout causes as transient (no GlitchTip on fallback exhaustion).
- **Store embed ([#937](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/937)):** Ollama circuit-breaker and other expected embedding conditions no longer trigger error monitoring from `memory-tools` store-embed.

## Install

```bash
npm install -g openclaw-hybrid-memory@2026.3.301
```

## Publish

```bash
cd extensions/memory-hybrid
npm run verify:publish
npm publish --otp=$OTP
```
