# Session Distillation Pipeline

**Extract durable knowledge from historical OpenClaw conversation logs**

## Overview

Session distillation is a **batch fact-extraction pipeline** that **indexes and processes old session logs and historical memories**: it runs over historical OpenClaw session transcripts, extracts durable facts, and stores them in the hybrid memory (SQLite + LanceDB). It complements the hybrid memory system's real-time auto-capture by retrospectively analyzing chat history.

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

For automated incremental distillation, add a cron job that runs at 02:00 local time:

### Cron Command

```bash
# Add to openclaw.json under "jobs" section
{
  "name": "nightly-memory-sweep",
  "schedule": "0 2 * * *",
  "channel": "system",
  "message": "Run nightly session distillation: last 3 days, Gemini model, isolated session. Log to scripts/distill-sessions/nightly-logs/YYYY-MM-DD.log",
  "isolated": true,
  "model": "gemini"
}
```

### What the Job Does

1. Identifies sessions from the last 3 days
2. Extracts conversational text
3. Sends to Gemini for fact extraction
4. Deduplicates against existing store
5. Stores net new facts (typically 2-5 per run)
6. Logs results to `nightly-logs/`

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

- [Hybrid Memory Manager v3 (docs/hybrid-memory-manager-v3.md)](hybrid-memory-manager-v3.md) — Full deployment reference
- [SETUP-AUTONOMOUS.md](SETUP-AUTONOMOUS.md) — AI-friendly autonomous setup
- [Run Report Example (docs/run-reports/example-distillation-report.md)](run-reports/example-distillation-report.md) — Example distillation report (placeholder data)

---

**Next Steps:**

1. Run the [manual pipeline](#running-the-pipeline-manually) for initial bulk distillation
2. Set up the [nightly cron job](#nightly-cron-setup) for ongoing incremental capture
3. Review metrics weekly in `nightly-logs/`
4. Tune extraction criteria based on yield and quality

**Questions?** Check [troubleshooting](#troubleshooting) or review the scripts in `scripts/distill-sessions/README.md`.
