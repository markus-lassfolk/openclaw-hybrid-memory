# Release Notes — OpenClaw Hybrid Memory 2026.3.300

**Date:** 2026-03-30

## Summary

Version **2026.3.300** follows **2026.3.293** with:

- **CI:** Reliable install smoke test (no stale tarball; correct `npm pack` selection).
- **Session narratives:** When the gateway stops or requests abort, narrative LLM work is skipped with an **info** line and **no** error-reporter noise — not a **warn** “build failed”.

## Install

```bash
npm install -g openclaw-hybrid-memory@2026.3.300
```

## Publish

```bash
cd extensions/memory-hybrid
npm run verify:publish
npm publish --otp=$OTP
```
