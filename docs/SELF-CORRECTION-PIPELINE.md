# Self-Correction Analysis Pipeline

Automated detection of user corrections/nudges in session logs and remediation (memory store, TOOLS.md rules, and proposed AGENTS/skill changes).

## Multi-language support

Correction **detection** uses phrases (e.g. “that was wrong”, “try again”) from the same system as memory triggers:

- **English** phrases are built in; **other languages** come from `.language-keywords.json`.
- Run **`openclaw hybrid-mem build-languages`** once (or when you add new languages). It detects top languages from your memory and translates **correction signals** (and other keyword groups) into those languages. After that, `self-correction-extract` matches user messages in any of those languages.

So for full multi-language support: run `build-languages`, then use the self-correction commands or nightly job as below.

---

## Commands

### 1. Extract incidents (Phase 1)

Scans session JSONL from the last N days and finds user messages that look like corrections, using the merged correction signals (English + translated from `.language-keywords.json`).

```bash
# Default: last 3 days, print summary (and incidents to stdout if any)
openclaw hybrid-mem self-correction-extract

# Last 7 days, write incidents to a file for review or Phase 2
openclaw hybrid-mem self-correction-extract --days 7 --output /path/to/incidents.json
```

- **Sessions** are read from `~/.openclaw/agents/*/sessions/*.jsonl` (same as session distillation).
- **Skip filters**: heartbeat prompts, cron job text, compaction messages, sub-agent announcements, very short messages.
- **Output**: `{ incidents: [...], sessionsScanned }`. Each incident has `userMessage`, `precedingAssistant`, `followingAssistant`, `timestamp`, `sessionFile`.

### 2. Analyze + remediate + report (Phases 2–4)

Takes incidents (from a file or by running extract in memory), sends them to the LLM for categorization and remediation type, then:

- **MEMORY_STORE**: Stores the suggested fact. Dedup is **exact text** plus **semantic** (embedding similarity) when `selfCorrection.semanticDedup` is true (default). Threshold configurable via `selfCorrection.semanticDedupThreshold` (default 0.92).
- **TOOLS_RULE**: By default, suggested rules **are applied** (inserted under the configured section, e.g. “Self-correction rules”). To **opt out** of applying: set **`selfCorrection.applyToolsByDefault: false`** in config, or pass **`--no-apply-tools`** for that run. When opt-out is set, use **`--approve`** to apply for a run. **Auto-rewrite (opt-in):** set **`selfCorrection.autoRewriteTools: true`** to have the LLM **rewrite** the whole TOOLS.md instead of section insert.
- **AGENTS_RULE / SKILL_UPDATE**: Always added to the report as **proposals** (no auto-apply).

Cap: 5 auto-remediations per run. Report is written to `memory/reports/self-correction-YYYY-MM-DD.md`.

```bash
# Use incidents from file
openclaw hybrid-mem self-correction-run --extract /path/to/incidents.json

# Run extract in memory then analyze (no file)
openclaw hybrid-mem self-correction-run

# Preview only (no store, no TOOLS changes)
openclaw hybrid-mem self-correction-run --dry-run

# Skip applying TOOLS rules this run (only suggest in report)
openclaw hybrid-mem self-correction-run --no-apply-tools

# Force apply when config has applyToolsByDefault: false
openclaw hybrid-mem self-correction-run --approve

# Custom workspace and model
openclaw hybrid-mem self-correction-run --workspace /path/to/project --model gemini-2.0-flash
```

- **Workspace** (for TOOLS.md and `memory/reports/`): `--workspace`, or `OPENCLAW_WORKSPACE`, or `~/.openclaw/workspace`.
- **Model**: `--model` or `config.distill.defaultModel` or `gpt-4o-mini`.
- **`--no-apply-tools`**: Do not insert TOOLS rules this run (only suggest in report). Opt-out from default apply.
- **`--approve`**: Force apply TOOLS rules this run when config has `applyToolsByDefault: false`.

---

## Nightly cron job (optional)

To run the full pipeline nightly (e.g. 02:30 Europe/Stockholm):

1. **Extract** from the last 3 days (uses multi-language correction signals if `build-languages` has been run).
2. **Analyze** with the configured LLM (e.g. Gemini for cost/context).
3. **Auto-remediate** (memory store + TOOLS.md append; cap 5).
4. **Report** to `memory/reports/self-correction-YYYY-MM-DD.md`.

Example job definition (schedule format depends on your OpenClaw/jobs setup):

```json
{
  "name": "self-correction-analysis",
  "schedule": "30 2 * * *",
  "tz": "Europe/Stockholm",
  "message": "Run the nightly self-correction analysis: openclaw hybrid-mem self-correction-run. Uses last 3 days of sessions, multi-language correction detection from .language-keywords.json (run build-languages first for non-English). Report is written to workspace memory/reports/self-correction-YYYY-MM-DD.md.",
  "sessionTarget": "isolated",
  "model": "sonnet"
}
```

If your runner executes shell commands, you can instead run:

```bash
openclaw hybrid-mem self-correction-run
```

Ensure `OPENCLAW_WORKSPACE` (or your workspace root) is set so the report and TOOLS.md paths are correct.

---

## Configuration (optional)

Under `plugins.entries["openclaw-hybrid-memory"].config.selfCorrection`:

| Option | Default | Description |
|--------|---------|-------------|
| `semanticDedup` | `true` | Skip storing facts that are semantically similar to existing ones (embedding similarity). |
| `semanticDedupThreshold` | `0.92` | Similarity threshold 0–1; higher = stricter (fewer near-duplicates stored). |
| `toolsSection` | `"Self-correction rules"` | TOOLS.md section heading under which to insert rules. |
| `applyToolsByDefault` | `true` | When `true`, apply (insert) suggested TOOLS rules by default. Set `false` to only suggest (then use `--approve` to apply). Use CLI `--no-apply-tools` to skip applying for one run. |
| `autoRewriteTools` | `false` | When `true`, LLM rewrites TOOLS.md to integrate new rules (no duplicates/contradictions). When `false`, use section insert. |
| `analyzeViaSpawn` | `false` | When `true` and incident count > `spawnThreshold`, run Phase 2 (analyze) via `openclaw sessions spawn --model <spawnModel>` for large context (e.g. Gemini). |
| `spawnThreshold` | `15` | Use spawn for Phase 2 when incidents exceed this count. |
| `spawnModel` | `"gemini"` | Model for spawn when `analyzeViaSpawn` is true. |

Example (in `openclaw.json` or plugin config):

```json
"selfCorrection": {
  "semanticDedup": true,
  "semanticDedupThreshold": 0.92,
  "toolsSection": "Self-correction rules",
  "autoRewriteTools": false,
  "analyzeViaSpawn": true,
  "spawnThreshold": 15,
  "spawnModel": "gemini"
}
```

---

## Phase 2 via spawn (large incident batches)

For very large incident batches, Phase 2 (LLM analysis) can be run via **`openclaw sessions spawn`** so the analysis uses a separate process and a model with a large context (e.g. Gemini).

- Set **`selfCorrection.analyzeViaSpawn: true`** and optionally **`spawnThreshold`** (default 15). When incident count exceeds the threshold, the plugin runs `openclaw sessions spawn --model <spawnModel> --message "..." --attach <prompt-file>` and parses the JSON array from stdout.
- Requires the OpenClaw CLI and a working `sessions spawn` command. If spawn fails, the run returns an error.

---

## Historical testing (e.g. Feb 13–18)

To test with a fixed date range or existing extract:

1. Extract incidents from the last N days and save to a file:
   ```bash
   openclaw hybrid-mem self-correction-extract --days 6 --output /path/to/incidents.json
   ```
2. Run the pipeline on that file (optionally with `--dry-run` first):
   ```bash
   openclaw hybrid-mem self-correction-run --extract /path/to/incidents.json
   # Or with approval for TOOLS rules:
   openclaw hybrid-mem self-correction-run --extract /path/to/incidents.json --approve
   ```

Adjust `--days` and paths as needed. The report is still written to `memory/reports/self-correction-YYYY-MM-DD.md` (today’s date).

---

## Protocol summary (for the cron agent)

1. Run **`openclaw hybrid-mem self-correction-extract --days 3`** (or rely on **`self-correction-run`** to do the extract in memory).
2. Run **`openclaw hybrid-mem self-correction-run`** (optionally with `--extract <path>` if you saved incidents to a file).
3. Report path: **`<workspace>/memory/reports/self-correction-YYYY-MM-DD.md`**. Review proposals (AGENTS_RULE / SKILL_UPDATE) before applying.

---

## Related

- [GitHub issue #34: Nightly Self-Correction Analysis](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/34)
- **build-languages**: [CLI reference](CLI-REFERENCE.md) — run first for non-English correction detection.
- **Session distillation**: [SESSION-DISTILLATION.md](SESSION-DISTILLATION.md) — separate pipeline (fact extraction from sessions).
