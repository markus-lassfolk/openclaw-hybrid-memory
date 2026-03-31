# Release Notes — OpenClaw Hybrid Memory 2026.3.293

**Date:** 2026-03-29

## Summary

Version **2026.3.293** publishes the current `main` line after merging:

- **[#922](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/922)** — refactor(security): centralize `process.env` and `child_process` (`utils/env-manager.ts`, `utils/process-runner.ts`).
- **[#923](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/923)** — README revamp for onboarding and engagement.

It builds on **2026.3.292** (Phase 1–aligned `hybrid-mem config` / rich `stats` and exported `PHASE1_CORE_ONLY_FORCE_DISABLED_KEYS`).

## Install

```bash
npm install -g openclaw-hybrid-memory@2026.3.293
```

## Publish (maintainer)

```bash
cd extensions/memory-hybrid
npm run verify:publish
npm publish --otp=$OTP
```

Use `--tag private` (or another dist-tag) if you do not want to move `latest` yet.
