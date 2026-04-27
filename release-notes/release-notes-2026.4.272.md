# Release Notes — OpenClaw Hybrid Memory 2026.4.272

**Date:** 2026-04-27  
**Previous release:** [2026.4.271](release-notes-2026.4.271.md)

---

## At a glance

Use **2026.4.272** when you want the **passive observer** to **ignore OpenClaw checkpoint session files** (basenames containing **`.checkpoint.`**, e.g. `{session}.checkpoint.{id}.jsonl`) and **`.deleted*`** tombstones so logs stay clean and the observer does not attempt to parse huge non-transcript JSONL lines.

---

## What changed

### Passive observer

- **Session scan filter:** Only transcript-style `*.jsonl` basenames are scanned; **checkpoint sidecars** and **deleted** markers are skipped (`isPassiveObserverTranscriptCandidate`).
- **Effect:** Stops **“skipping oversized JSONL line in session …checkpoint…”** warnings; no change to extraction logic for normal session logs.

---

## Upgrade steps

1. **Upgrade the plugin** to **2026.4.272**:

   ```bash
   npm install -g openclaw-hybrid-memory@2026.4.272
   ```

2. Restart the gateway, then run **`openclaw hybrid-mem verify`** as usual.

---

## Breaking changes

None intentionally.

---

## Links

- **[CHANGELOG.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)** — section **`[2026.4.272]`**
- **Previous release notes:** [2026.4.271](release-notes/release-notes-2026.4.271.md)
