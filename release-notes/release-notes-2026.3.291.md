# Release Notes — OpenClaw Hybrid Memory 2026.3.291

**Release date:** 2026-03-29  
**Previous release:** [2026.3.290](release-notes-2026.3.290.md) (2026-03-29)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md#20263291---2026-03-29)

**Note:** User-visible behavior matches **2026.3.290**. **2026.3.291** republishes the plugin so the npm tarball includes the `benchmark/` tree (shadow-eval / `hybrid-mem benchmark`). If you already copied `benchmark/` manually for 2026.3.290, upgrading to **2026.3.291** is optional but recommended for clean installs.

---

## Overview

Version **2026.3.291** bundles several major product themes: **episodic memory** (what happened and whether it succeeded), **edicts** (human-approved ground truth that always reaches the model), **procedure learning** with explicit success/failure feedback, and **smarter auto-capture** when the same entities or credentials show up often. On top of that, operators running **Azure API Management** get first-class embedding auth and routing, Mission Control gains **visualization and health surfaces**, and the codebase has absorbed a broad **reliability pass** (SQLite lifecycle, WAL, FTS, LanceDB, credentials, task queue, and recall).

If you are upgrading from **2026.3.260**, you should expect new SQLite migrations (episodes, edicts, procedure feedback, mentions) on first start — back up `facts.db` before upgrading production installs.

---

## For users and operators

### Episodic memory — “What happened, and did it work?”

Agents can record structured **episodes**: short event summaries with an explicit **outcome** (`success`, `failure`, `partial`, or `unknown`), timestamps, optional links to procedures and related facts, and normal memory metadata (scope, importance, decay). Failures are automatically treated as more important so they surface in recall.

- **Tools:** `memory.record_episode` and `memory.search_episodes` (filter by outcome, time range, procedure, and text).
- **Automation:** When a session is compacted, the plugin scans recent session text for common outcome phrases and can create episodes without extra tool calls.

This makes long-running agents much better at answering “what have we tried before?” and “what usually breaks?”

### Edicts — ground truth with a human gate

**Edicts** are a separate, high-trust memory lane: verified facts stored in their own table, with TTL options, dedicated tools (`add` / `list` / `get` / `update` / `remove` / `stats`), and **forced injection** near the start of the system prompt. They are **not dropped** when token budgets get tight.

**Important:** agents do **not** create edicts silently. They propose candidates (e.g. via `[EDICT CANDIDATE]` on GitHub); a human reviews and creates the edict. This keeps “canonical truth” under your control.

### Procedure feedback — learn from real runs

Procedures now carry **version history** and **failure notes**. Agents can call `memory.procedure_feedback` after a run; failures bump version metadata, record avoidance hints, and can spawn a linked episode. Recall of procedures includes **last outcome**, **success rate**, and **avoidance notes** so the model sees history before repeating a bad playbook.

CLI additions: `memory procedure show <id>` and richer `memory procedure list`.

### Frequency-based auto-save

Repeated mentions of the same **entity** can automatically become memories once a configurable threshold is hit. **Credentials** detected in that flow go to the **vault**, with **hashed** mention text (raw secrets are not stored in the mentions table) and sensible supersession rules for multiple logins per host.

Tune via `FrequencyCaptureConfig`: thresholds, lookback sessions, default importance, credential capture, and TTL for stale mentions.

### Azure APIM and embeddings

If you route OpenAI-compatible embedding calls through **Azure API Management**, this release aligns the plugin client and verification paths with **APIM auth**, supports **deployment name** overrides, and improves **endpoint inheritance** so local and hosted setups behave predictably. The **`hybrid-mem model-info`** command helps confirm **embedding dimensions** and provider configuration from the shell.

### Mission Control

Integrated UI work from upstream includes:

- **Memory graph visualization** — explore how memories connect.
- **Agent Health Dashboard** — surface runtime health signals.
- **Cross-agent Audit Trail** — trace activity across agents where enabled.

(Exact availability depends on your OpenClaw / Mission Control deployment.)

### Token budget trimming

Recall and injection respect **tiered trimming** with **`preserveUntil`** and **`preserveTags`** so critical slices of context survive aggressive budgets better than a single flat truncation.

---

## Under the hood (stability and maintainability)

- **Facts database** code paths were refactored into smaller modules (connection handling, query helpers, FTS text helpers, caching) to reduce risk and duplication.
- **Shared `embed-call`** utility consolidates embedding invocation patterns.
- **Credential validation** and **scope filtering** received targeted improvements aligned with security and multi-agent rules.
- Multiple PRs addressed **FTS5**, **WAL**, **LanceDB fallback**, **SQLite reopen after gateway restart**, **task-queue locking**, and **recall** edge cases — see the full changelog for issue/PR references (#909, #917, #918, #921, and others).

---

## Upgrade steps

1. **Back up** your SQLite database (default `~/.openclaw/memory/facts.db` or your configured path) and LanceDB directory if you rely on them.
2. **Update the plugin** (npm global or your install method):

   ```bash
   npm install -g openclaw-hybrid-memory@2026.3.291
   ```

3. **Restart** the OpenClaw gateway so the new plugin version loads and migrations run once.
4. If you use **Azure APIM**, re-check `embedding` config (endpoint, deployment, API key or managed identity as applicable) and run:

   ```bash
   hybrid-mem verify --test-llm
   ```

   …to confirm embeddings and LLM probes against your environment.

---

## Links

- [CHANGELOG.md](../CHANGELOG.md) — complete per-area bullet list  
- [GitHub releases](https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases) — tags and assets when published
