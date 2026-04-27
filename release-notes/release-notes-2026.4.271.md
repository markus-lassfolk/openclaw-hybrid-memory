# Release Notes — OpenClaw Hybrid Memory 2026.4.271

**Date:** 2026-04-27  
**Previous release:** [2026.4.270](release-notes-2026.4.270.md)

---

## At a glance

Use **2026.4.271** when you need a **tagged build** that includes the latest **`verify --test-llm`** behavior against **Azure Foundry Responses** and **chat** rules, plus routine **dev dependency** updates. Runtime memory behavior from **2026.4.270** is unchanged for normal capture/recall flows.

---

## What changed

### `hybrid-mem verify --test-llm`

LLM connectivity checks now match **current provider constraints**:

- **Responses** probes use a sufficient **max output / token cap** (minimum sensible floor).
- **Chat** probes use **temperature `1`** where required (e.g. Azure **`gpt-5.5`** SKUs).
- **`azure-foundry/o3-pro`** is probed through the **Responses** path.
- **OAuth** and **API-key** configurations share consistent **Responses** routing where applicable.

### Maintenance

- **Dependabot** minor/patch dev dependency rollup (**#1169**).

---

## Upgrade steps

1. **Upgrade the plugin** to **2026.4.271** (same patterns as prior releases):

   ```bash
   npm install -g openclaw-hybrid-memory@2026.4.271
   ```

2. Re-run **`openclaw hybrid-mem verify`**; if you use **`--test-llm`**, expect **aligned** pass/fail semantics with **2026.4.270** plus the probe fixes above.

---

## Breaking changes

None intentionally.

---

## Links

- **[CHANGELOG.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)** — section **`[2026.4.271]`**
- **Previous release notes:** [2026.4.270](release-notes/release-notes-2026.4.270.md)
