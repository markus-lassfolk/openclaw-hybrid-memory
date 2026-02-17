---
layout: default
title: Session Distillation
parent: Features
nav_order: 3
---
# Session Distillation Pipeline

**Extract durable knowledge from historical OpenClaw conversation logs**

## What the distill job actually does

When you run the pipeline (manually or via the nightly job), it:

1. **Decides the window** — Run `openclaw hybrid-mem distill-window` (or `--json` for machine-readable output):
   - **If last run is empty** (no `.distill_last_run` or first time): **full** distill of history, limited to the **last 90 days** (configurable in code; avoids unbounded first run).
   - **If last run is not empty**: **incremental** — process from the **earlier** of (last run date, today − 3 days) through today. So you never miss a gap, and you get at least a 3-day overlap.
2. **Finds** session logs in that window — e.g. OpenClaw conversation JSONL under `~/.openclaw/agents/.../sessions/` (use `mtimeDays` from distill-window: `find ... -mtime -<mtimeDays>`).
3. **Extracts text** — turns each session into readable conversation text (skips raw tool payloads/system noise).
4. **Extracts facts** — sends batches of that text to an LLM (e.g. Gemini) with a prompt that asks for structured facts: category (`preference`, `fact`, `decision`, `technical`, `person`, `project`, etc.), entity, key, value, and optional source date.
5. **Dedupes** — for each candidate fact, checks existing memory (e.g. via `memory_recall`) and **skips** it if something substantially similar is already stored.
6. **Stores** only **net new** facts via `memory_store` (and thus into SQLite + LanceDB), tagged with date so you know when they were distilled.
7. **Logs** — writes a short summary (sessions scanned, facts extracted, new facts stored) to e.g. `scripts/distill-sessions/nightly-logs/YYYY-MM-DD.md`.
8. **Records the run** — always run `openclaw hybrid-mem record-distill` at the end so the next run uses the correct incremental window and `verify` shows “last run”.

So in one sentence: **it re-reads conversation logs in a chosen window (full or incremental), has an LLM pull out durable facts, dedupes against what’s already in memory, stores only the new ones, and records the run.**

---

## Overview

Session distillation is a **batch fact-extraction pipeline** that **indexes and processes old session logs and historical memories**: it runs over historical OpenClaw session transcripts, extracts durable facts (and credentials when present), and stores them in the right place in **one run**. Facts go to hybrid memory (SQLite + LanceDB); credentials are routed automatically—to the **Secure Credential Vault** (plus a pointer in memory) when the vault is enabled, or to memory when it is not. No separate “facts” vs “credentials” distillation runs are needed. It complements the hybrid memory system's real-time auto-capture by retrospectively analyzing chat history.

**Model choice:** The pipeline is designed to use **Google (Gemini)** for fact extraction. Gemini’s **1M+ token context window** lets you process large batches of old sessions in a single sub-agent run (e.g. ~50 sessions / ~500k tokens per batch by default; you can increase batch size to leverage the full window). Configure Gemini in OpenClaw and use `--model gemini` when spawning the distillation sub-agent (see [Running the Pipeline](#running-the-pipeline-manually) and [Nightly Cron Setup](#nightly-cron-setup)).

### Why Session Distillation?

Live auto-capture (via `memory-hybrid` plugin) catches **~73% of important facts** during active conversations. The remaining ~27% slip through because:

- Facts were mentioned casually in passing (not emphasized)
- The agent was focused on a different task
- Conversations from before auto-capture was enabled
- Context was clear at the time but not explicitly saved
- Technical details embedded in debugging sessions
- Preferences expressed implicitly through repeated behavior

**Session distillation catches the rest.**

---

## Two-Phase Approach

### Phase 1: Bulk Historical Distillation

**Purpose:** One-time sweep of all existing sessions to extract historical knowledge.

**When to run:**
- Initial setup (after deploying the hybrid memory system)
- After accumulating significant session history without distillation
- Quarterly for comprehensive memory consolidation

**Expected yield:**
- Typically 20–30 net new facts per full sweep (e.g. 500–1000 sessions); varies with history
- Higher yield if sessions predate auto-capture deployment

**Cost estimate:**
- **Session indexing:** One-time cost to create searchable session index (if using memorySearch)
- **Full distillation:** On the order of a few dollars (e.g. Gemini 3 Pro, ~7M tokens across batches)

### Phase 2: Nightly Incremental Sweep

**Purpose:** Automated daily processing of recent sessions to catch any facts missed by auto-capture.

**When to run:** Automated via cron at 02:00 local time

**Scope:** Last 3 days of sessions (overlapping window for safety)

**Expected yield:** ~2-5 new facts per nightly run

**Cost estimate:** ~$0.05–0.10 per run (e.g. Gemini 3 Pro, smaller batch)

**Setup:** See [Nightly Cron Setup](#nightly-cron-setup) section below

---

## Architecture

### Pipeline Components

```
Session JSONL files
    ↓
[1] batch-sessions.sh  → Organize into batches (~50 sessions each)
    ↓
[2] extract-text.sh    → Convert JSONL to human-readable text
    ↓
[3] Gemini sub-agent   → Extract facts using gemini-prompt.md
    ↓
[4] Deduplication      → Remove duplicates, check against store
    ↓
[5] store-facts.sh     → Generate memory_store commands
    ↓
Memory Store (SQLite + LanceDB)
```

### Scripts

| Script | Purpose |
|--------|---------|
| **batch-sessions.sh** | Splits session files into manageable batches (~50 sessions, ~500k tokens each) sorted oldest-first |
| **extract-text.sh** | Extracts conversational text from session JSONL files, skipping tool calls and system messages |
| **store-facts.sh** | Converts extracted facts (JSONL) into `openclaw memory store` commands |
| **gemini-prompt.md** | LLM prompt template for fact extraction (categories, format, quality criteria) |
| **run-stats.md** | Template for tracking distillation metrics per run |

### Fact Categories

The pipeline extracts facts into standard memory categories:

- **`preference`** — User habits, preferences, UI choices
- **`technical`** — Configs, APIs, IP addresses, system specs
- **`decision`** — Architectural choices, project direction
- **`person`** — Contact info, relationships, roles
- **`project`** — Goals, status, requirements, milestones
- **`place`** — Locations, addresses
- **`entity`** — Companies, tools, services, products

---

## Running the Pipeline Manually

### Step 1: Create Session Batches

```bash
cd /path/to/openclaw-hybrid-memory/scripts/distill-sessions   # or your workspace copy
./batch-sessions.sh
```

**Output:** `batches/batch-001.txt`, `batch-002.txt`, etc. (file list, not content)

### Step 2: Extract Conversational Text

```bash
mkdir -p extracted
./extract-text.sh $(cat batches/batch-001.txt) > extracted/batch-001.txt
```

**Repeat for each batch** (or script it):

```bash
for batch in batches/*.txt; do
  ./extract-text.sh $(cat "$batch") > "extracted/$(basename "$batch")"
done
```

### Step 3: Extract Facts with Gemini

Use a sub-agent spawn to process each batch with **Gemini** (recommended for its 1M+ context window when processing old logs):

```bash
mkdir -p facts

openclaw sessions spawn \
  --model gemini \
  --label distill-batch-001 \
  --message "$(cat gemini-prompt.md)" \
  --attach extracted/batch-001.txt \
  > facts/batch-001.jsonl
```

**Important:** Review output to ensure it's valid JSONL (not markdown-wrapped).

### Step 4: Deduplicate Facts

The distillation process includes two-phase deduplication:

1. **Internal deduplication:** Remove duplicates within the extraction batch (newest wins)
2. **Store check:** Compare remaining facts against existing memory store

**Manual deduplication script** (if needed):

```bash
# Combine all facts
cat facts/*.jsonl > all-facts.jsonl

# Run dedup (example using jq + custom script)
node process-facts.js all-facts.jsonl > facts-deduplicated.jsonl
```

### Step 5: Store Facts

```bash
# Generate memory_store commands
./store-facts.sh facts-deduplicated.jsonl > commands.sh

# Review commands (important!)
less commands.sh

# Execute if satisfied
chmod +x commands.sh
./commands.sh

# Record that distillation was run (so 'openclaw hybrid-mem verify' can show last run)
openclaw hybrid-mem record-distill
```

### Step 6: Track Metrics

Update `run-stats.md` with:
- Total facts extracted
- Duplicates removed
- Net new facts stored
- Cost and time metrics
- Quality observations

---

## Nightly Cron Setup

For automated incremental distillation, add a scheduled job that runs at 02:00 local time.

**Note:** OpenClaw's config schema does not accept a top-level `"jobs"` key in `openclaw.json`. Use one of:

- **OpenClaw's cron/scheduled jobs** — If your OpenClaw version supports it, add the job via the OpenClaw UI or the cron store (e.g. `~/.openclaw/cron/jobs.json`). See OpenClaw's documentation for the correct format and location.
- **System cron** — Add a crontab entry that runs the distillation script or invokes OpenClaw with the appropriate message at 02:00.

### Job definition (for reference)

When OpenClaw supports a jobs array, the nightly sweep would look like:

```json
{
  "name": "nightly-memory-sweep",
  "schedule": "0 2 * * *",
  "channel": "system",
  "message": "Run nightly session distillation: last 3 days, Gemini model, isolated session. Log to scripts/distill-sessions/nightly-logs/YYYY-MM-DD.log",
  "isolated": true,
  "model": "gemini"
}
```

### Window logic (`openclaw hybrid-mem distill-window`)

- **Last run empty or missing:** do a **full** distill of the **last 90 days** (max), then record the run.
- **Last run present:** do an **incremental** run from the **earlier** of (last run date, today − 3 days) through today; then record the run.

Use `openclaw hybrid-mem distill-window` at the start of the job to get `mode`, `startDate`, `endDate`, and `mtimeDays`. Use `distill-window --json` for machine-readable output.

### What the job should do

1. **Get the window:** Run `openclaw hybrid-mem distill-window --json`. Parse `mode`, `startDate`, `endDate`, `mtimeDays`.
2. Find session JSONL files in that window (e.g. `find ... -mtime -<mtimeDays>`).
3. Extract conversational text (e.g. via `scripts/distill-sessions/extract-text.sh`).
4. Extract facts with the LLM (Gemini or other), dedupe against memory_recall, store net new facts via memory_store. Extracted credentials are routed the same way as in real time: to the secure vault (plus a pointer in memory) when the vault is enabled, or to memory when it is not.
5. Log a short summary to `nightly-logs/YYYY-MM-DD.md`.
6. **Always** run `openclaw hybrid-mem record-distill` at the end so the next run uses the correct window.

### Suggested nightly job message (cron store)

Use this as the job’s `payload.message` (or equivalent) so the agent follows the window logic:

```
Run the nightly memory distillation pipeline.

1. Get the window: run `openclaw hybrid-mem distill-window --json`. Parse the JSON (mode, startDate, endDate, mtimeDays).
2. Find session files in that window: e.g. find ~/.openclaw/agents/main/sessions/ -name '*.jsonl' -not -name '*.deleted.*' -mtime -<mtimeDays> (use mtimeDays from step 1).
3. Extract text using scripts/distill-sessions/extract-text.sh (or equivalent) for those files.
4. Extract facts from the text using the LLM (category, entity, key, value, source date). For each fact, check memory_recall for similar — skip if already stored. Store only net new facts via memory_store, prefixed with [YYYY-MM-DD]. Credentials extracted from sessions are routed like in real time: to the secure vault (plus a pointer in memory) when the vault is enabled, or to memory when it is not.
5. Write a brief summary to scripts/distill-sessions/nightly-logs/YYYY-MM-DD.md (sessions scanned, facts extracted, new stored).
6. Run openclaw hybrid-mem record-distill so the next run uses the correct incremental window.

Report: mode (full/incremental), window start/end, sessions scanned, facts extracted, new facts stored. Be efficient — this runs every night.
```

### Expected Behavior

- **Runtime:** 2-5 minutes per run
- **Cost:** ~$0.05-0.10 per run (Gemini 3 Pro)
- **Yield:** 2-5 new facts per run (varies with activity)
- **Errors:** Logged to `nightly-logs/` for review

---

## Deduplication Strategy

### Oldest-First Processing

Sessions are sorted by date (oldest first) before batching. This ensures:

- **Temporal coherence:** Related facts from the same time period are processed together
- **Consistent provenance:** Each fact is tagged with its source session date `[YYYY-MM-DD]`
- **Newer facts win:** When duplicates are found across batches, the fact from the later batch supersedes earlier ones

### Dedup Logic

1. **Signature matching:** Facts with identical `category::entity::key` are considered duplicates
2. **Within-batch dedup:** Latest `source_date` wins
3. **Store check:** Before storage, each fact is checked against the existing memory store via:
   - Pattern matching (known fact structures)
   - Sample `memory_recall` queries
   - Embedding similarity (for edge cases)

### Duplicate Handling

- **SKIP:** Fact already in store (verified via recall)
- **CHECK:** Fact needs manual review (ambiguous)
- **STORE:** Net new fact, safe to add

**Result:** Typically 20-30% of extracted facts are truly novel; the rest are already captured.

---

## Source Date Preservation

**Preferred:** Use the `source_date` field. The facts table has a `source_date` column (FR-003). **When parsing old memories, always include source_date if it is available** (from session filenames, `[YYYY-MM-DD]` prefixes, or conversation context). Pass it via:

- **JSONL:** Add optional `source_date` (YYYY-MM-DD) per fact; `store-facts.sh` forwards it to `openclaw hybrid-mem store --source-date`
- **Gemini prompt:** Extracts `source_date` from SESSION markers when the filename contains a date (e.g. `2026-01-15-session.jsonl` → `"2026-01-15"`)
- **CLI:** `openclaw hybrid-mem store --text "..." --source-date 2026-01-15`
- **memory_store tool:** Optional `sourceDate` parameter (ISO-8601 string or Unix seconds)

Legacy: Facts can still be prefixed in text with `[YYYY-MM-DD]`, but `source_date` is queryable and used for conflict resolution.

**Why this matters:**

- **Temporal context:** Know when information was first discussed
- **Fact evolution:** Track how knowledge changed over time
- **Debugging:** Trace facts back to source sessions
- **Quality review:** Identify patterns in what was missed during live capture

---

## Performance & Cost

### Initial Bulk Distillation (example scale)

| Metric | Example |
|--------|---------|
| **Total sessions** | e.g. 500–1000 |
| **Batches created** | ~15–20 (~50 sessions each) |
| **Total tokens processed** | ~7M |
| **Facts extracted** | ~100–200 |
| **Duplicates removed** | varies |
| **Already in store** | typically 70–80% of extracted |
| **Net new facts stored** | typically 20–30 |
| **Total cost** | ~$2–5 (model-dependent) |
| **Runtime** | ~30–60 minutes |

### Nightly Incremental Run (3-day window)

| Metric | Value |
|--------|-------|
| **Sessions processed** | ~10–20 (varies by activity) |
| **Tokens processed** | ~100k–200k |
| **Net new facts** | 2–5 per run |
| **Cost per run** | ~$0.05–0.10 |
| **Runtime** | 2–5 minutes |

### Cost Breakdown

- **Session indexing (one-time):** If using memorySearch for session transcript search
- **Model input/output:** Depends on provider (e.g. Gemini 3 Pro, OpenAI)
- **Embeddings:** If used for vector dedup (e.g. OpenAI)

**Total yearly cost estimate (nightly runs):** on the order of tens of dollars

---

## Quality Control

### Pre-Storage Review

**Before running `commands.sh`:**

1. **Sample check:** Review 10-20 random facts for quality
2. **Pattern detection:** Look for noise (ephemeral debugging, tool spam)
3. **Category distribution:** Are facts properly classified?
4. **Completeness:** Do facts have proper `entity`, `key`, and `value` fields?

### Post-Storage Verification

```bash
# Check memory stats
openclaw hybrid-mem stats

# Test recall on new facts
openclaw hybrid-mem search "preference"
openclaw hybrid-mem search "Cinema sensor"

# Review entity distribution
openclaw hybrid-mem lookup <entity>
```

### Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| **Low-value facts** | Gemini extracting ephemeral details | Tighten extraction criteria in `gemini-prompt.md` |
| **Duplicate categories** | Facts stored as "other" | Run `openclaw hybrid-mem classify` after storage |
| **Missing context** | Fact text too terse | Add "preserve technical context" rule to prompt |
| **Tool spam** | Tool output mistaken for conversation | Verify `extract-text.sh` filters properly |

---

## Maintenance

### When to Run Full Distillation

- **Initial setup:** After deploying hybrid memory system
- **Quarterly:** Every 3 months to catch any nightly gaps
- **After major projects:** To capture dense technical context
- **Before system migrations:** To ensure knowledge is preserved

### When to Review Nightly Logs

- **Weekly:** Quick scan of `nightly-logs/` for errors
- **Monthly:** Aggregate stats (total facts stored, average yield)
- **On anomalies:** If yield drops to 0 or spikes above 10

### Pipeline Tuning

**If yield is too low (<1 fact per run):**
- Loosen extraction criteria in `gemini-prompt.md`
- Increase session window (3 days → 5 days)

**If yield is too high (>10 facts per run):**
- Check for duplicates slipping through dedup
- Review fact quality (are they all valuable?)
- Tighten extraction criteria

---

## Troubleshooting

### "No text extracted from session"

**Cause:** Session may be pure tool calls (cron jobs, sub-agent tasks)

**Fix:** Normal; not every session has conversational content. Skip these.

**Verify:**

```bash
jq 'select(.type=="message") | .message.role' session.jsonl | sort | uniq -c
```

### "Gemini outputs markdown instead of JSONL"

**Cause:** Model wraps output in code fences

**Fix:** Update `gemini-prompt.md`:

```
Output must be valid JSONL. One fact per line. NO markdown, NO code fences, NO formatting.
```

### "Too many low-value facts"

**Cause:** Extraction criteria too loose

**Fix:**
- Add negative examples to prompt ("Do NOT extract...")
- Post-filter with jq: `cat facts.jsonl | jq 'select(.importance > 0.6)'`

### "Facts already in store"

**Cause:** Normal! Memory auto-capture works well.

**Expected:** 70-80% of extracted facts are already captured.

**Action:** Focus on the 20-30% that are truly new.

---

## Inspiration & Credits

**Concept inspired by [virtual-context](https://github.com/virtual-context)** — the idea of "memory archaeology" to recover knowledge from conversational history.

**Implementation:** Custom pipeline built on OpenClaw's hybrid memory system (SQLite + FTS5 + LanceDB).

---

## Further Reading

- [README](../README.md) — Project overview and all docs
- [QUICKSTART.md](QUICKSTART.md) — Installation and first run
- [SETUP-AUTONOMOUS.md](SETUP-AUTONOMOUS.md) — AI-friendly autonomous setup
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — `distill-window`, `record-distill`, `extract-daily` commands
- [CREDENTIALS.md](CREDENTIALS.md) — How credentials are routed during distillation
- [MAINTENANCE.md](MAINTENANCE.md) — Backfill from session logs
- [Run Report Example (docs/run-reports/example-distillation-report.md)](run-reports/example-distillation-report.md) — Example distillation report (placeholder data)

---

**Next Steps:**

1. Run the [manual pipeline](#running-the-pipeline-manually) for initial bulk distillation
2. Set up the [nightly cron job](#nightly-cron-setup) for ongoing incremental capture
3. Review metrics weekly in `nightly-logs/`
4. Tune extraction criteria based on yield and quality

**Questions?** Check [troubleshooting](#troubleshooting) or review the scripts in `scripts/distill-sessions/README.md`.
