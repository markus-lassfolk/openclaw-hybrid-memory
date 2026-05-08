# Release Notes — OpenClaw Hybrid Memory 2026.3.292

**Date:** 2026-03-29

## Summary

This release fixes **misleading CLI output** when the **Phase 1 core-only baseline** (plugin ≥2026.3.140) forces features off while `openclaw.json` still lists `enabled: true`. **`hybrid-mem config`** and **`hybrid-mem stats`** (rich) now line up with **effective runtime config**, with short notes when the file disagrees.

No change to memory behavior, Phase 1 overrides, or defaults—this is **operator UX and packaging** only.

## Install

```bash
npm install -g openclaw-hybrid-memory@2026.3.292
```

## Private / pre-`latest` testing

To keep **`latest`** on an older build while you benchmark extended features:

```bash
cd extensions/memory-hybrid
npm run verify:publish
npm publish --tag private --otp=$OTP
```

Then install explicitly:

```bash
npm install -g openclaw-hybrid-memory@private
# or pin the version
npm install -g openclaw-hybrid-memory@2026.3.292
```

When you are ready for everyone to get this build by default, promote the tag:

```bash
npm dist-tag add openclaw-hybrid-memory@2026.3.292 latest
```

(Adjust workflow if your release process uses GitHub Actions or another registry.)

## Changes

- **Config view:** Effective on/off for all Phase 1–forced optional keys; optional rows for workflow tracking, verification store, retrieval aliases, query reranking, contextual variants; Phase 1 note when the JSON file still shows enabled.
- **Rich stats:** Clearer proposals and credentials lines vs effective config.
- **Code:** `PHASE1_CORE_ONLY_FORCE_DISABLED_KEYS` exported from `config/parsers` (used by the migration and aligned with the CLI).
