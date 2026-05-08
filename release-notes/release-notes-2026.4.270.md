# Release Notes — OpenClaw Hybrid Memory 2026.4.270

**Date:** 2026-04-27  
**Previous release:** [2026.4.260](release-notes-2026.4.260.md) (2026-04-26)

---

## At a glance

This release tightens **LLM-facing parsing**, **HTTP error handling**, **SQL generation**, **embedding inputs**, and **vector DB / lifecycle** edge cases introduced or surfaced after **2026.4.260**. Upgrading from **2026.4.260** should be **drop-in** for most deployments; skim **Fixed** below if you rely heavily on **batch classification**, **custom episode scopes**, or **embedding-heavy** workflows.

---

## What changed (in plain language)

- **Batch classify and JSON-from-LLM:** The plugin is **less brittle** when the model returns **extra prose**, **markdown fences**, or a **`[Context:…]`** line before the JSON array.
- **Chat / auto-classifier:** Fewer crashes when the API returns **no `choices`**, and **clearer handling** of some **400** / **unsupported** responses.
- **Episode search SQL:** Scoped queries no longer risk a broken **`WHERE AND …`** when the scope clause already starts with **`AND`**.
- **Embeddings:** Very long inputs are **truncated** to a safe size before the API call; **context-length** style failures can be **suppressed** from noisy error paths where appropriate.
- **Vector DB startup:** Initialization failures always flow through **proper `Error` reporting**; **hot-reload** races are less likely to **double-report** to error trackers.
- **Injection / edicts:** When the **database is not open**, edict-related paths avoid **misleading** external error attribution.

*(Issues #1151–#1167, PR #1168.)*

---

## Upgrade steps

1. **Back up** your workspace memory dir and SQLite/Lance paths if you do not already snapshot them.
2. **Upgrade the plugin** (pick one pattern you already use):

   ```bash
   npm install -g openclaw-hybrid-memory@2026.4.270
   ```

   Or follow your usual **`openclaw plugins install`** / **`hybrid-mem upgrade`** flow for a workspace extension checkout.

3. Restart the **OpenClaw gateway** or extension host as you normally would after a plugin bump.
4. Run **`openclaw hybrid-mem verify`** (add **`--fix`** if you use non-destructive job normalization).

---

## Breaking changes

None intentionally.

---

## Links

- **[CHANGELOG.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)** — section **`[2026.4.270]`** for the authoritative bullet list.
- **Previous release notes:** [2026.4.260](release-notes-2026.4.260.md)
