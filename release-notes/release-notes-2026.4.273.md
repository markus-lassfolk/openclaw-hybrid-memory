# Release Notes — OpenClaw Hybrid Memory 2026.4.273

**Date:** 2026-04-27  
**Previous release:** [2026.4.272](release-notes-2026.4.272.md)

---

## At a glance

Use **2026.4.273** when you run **gpt-5\*** models through **Azure Foundry** or **APIM** and previously saw **HTTP 400** from non-default **`temperature`** / **`top_p`** on **chat.completions** or **Responses** (distill, reflection, classification, or routed gateway calls). This build omits those parameters for **gpt-5\*** the same way it already did for **o-series** reasoning models.

---

## What changed

### LLM request shaping

- **`shouldOmitSamplingParams`** in **`model-capabilities`**: true for **o-series** and any path segment matching **`gpt-5`** (case-insensitive).
- **Chat, classification, responses adapter, and provider router** skip sending custom sampling params when that helper is true, so providers use their default (typically temperature **1**).

---

## Upgrade steps

1. **Upgrade the plugin** to **2026.4.273**:

   ```bash
   npm install -g openclaw-hybrid-memory@2026.4.273
   ```

2. Restart the gateway, then run **`openclaw hybrid-mem verify`** as usual.

---

## Breaking changes

None intentionally. Behavior change: **gpt-5\*** calls no longer receive explicit **`temperature`** from the plugin (classification previously forced **0**; distill/reflection used low defaults). Outputs may be slightly less deterministic than before on endpoints that previously accepted custom values.

---

## Links

- **[CHANGELOG.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)** — section **`[2026.4.273]`**
- **Previous release notes:** [2026.4.272](release-notes/release-notes-2026.4.272.md)
