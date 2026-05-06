# Release notes — OpenClaw Hybrid Memory **2026.5.61**

**Baseline:** **[2026.5.60](release-notes-2026.5.60.md)** (OpenClaw **2026.5.x** readiness: `dist/`, `contracts.tools`, peers, SQLite outcome compat, CI smoke-install). **2026.5.61** is a follow-on patch on the same peer line (**OpenClaw `>=2026.5.0 <2027`**) focused on **operator visibility** for maintenance and reflection.

## Who should install

Anyone already on **2026.5.60** who wants clearer logs for **`hybrid-mem dream-cycle`**, **`reflect`**, **`run-all`**, and embedding-heavy reflection steps—especially when diagnosing **429 / rate limits** (chat vs **embeddings.create**).

## What changed (high level)

- **Dream cycle & wrappers**: `--verbose` / parent `-v` propagates through follow-up steps (continuous verification, extract-implicit, cross-agent learning, tool effectiveness); step labels and WAL flush summaries in-plugin.
- **Reflection**: always-on **`info`** checkpoints after the LLM (candidate count), through **dedupe embedding** (success counts), and a **finished** summary (stored vs duplicates vs embed failures).
- **Rate-limit lines**: chat retries show operation + model + attempt; embedding API retries are tagged **`memory-hybrid: embeddings.create`** (single and batch).

## Install

```bash
npm install -g openclaw-hybrid-memory@2026.5.61
```

Or add/update the plugin in your workspace / gateway config using the same version.

If you use **`openclaw-hybrid-memory-install`**, align it to **2026.5.61** so installer and plugin versions stay in sync.

## Changelog

See **[CHANGELOG.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)** — section **`[2026.5.61]`**.

## Earlier notes

- **2026.5.60** narrative and compatibility matrix: **[release-notes-2026.5.60.md](release-notes-2026.5.60.md)**.
- Draft **2026.5.50** context: **[release-notes-2026.5.50.md](release-notes-2026.5.50.md)**.
