# Session Log Distillation Pipeline

Extract facts, preferences, and knowledge from OpenClaw conversation history.

## Overview

This pipeline **indexes and processes old session logs and historical memories**: it reads session JSONL files from `~/.openclaw/agents/main/sessions/`, extracts durable knowledge, and stores it in the hybrid memory (SQLite + LanceDB). We use **Google (Gemini)** for the extraction step so we can leverage its **1M+ token context window** and process large batches of old sessions in one run. Run from this directory or copy the scripts to your workspace (e.g. `~/.openclaw/workspace/scripts/distill-sessions/`).

## Pipeline Components

### 1. `extract-text.sh`
Extracts human-readable conversation text from session files.

```bash
./extract-text.sh file1.jsonl file2.jsonl ... > output.txt
```

- Extracts only user + assistant text messages
- Skips tool calls, tool results, system messages
- Outputs with session markers

### 2. `batch-sessions.sh`
Splits sessions into manageable batches.

```bash
./batch-sessions.sh
```

- Creates `batches/batch-001.txt`, `batch-002.txt`, etc.
- ~50 sessions per batch (~500k tokens for Gemini)
- Sorts by date (oldest first)

### 3. `gemini-prompt.md`
Prompt template for fact extraction via Gemini sub-agent.

**When parsing old memories:** Include `source_date` (YYYY-MM-DD) in the output if available — from SESSION marker filenames (e.g. `2026-01-15-session.jsonl`), from `[YYYY-MM-DD]` prefixes in fact text (strip the prefix and put the date in source_date), or from dates mentioned in the conversation.

Categories extracted:
- `preference` - User habits, preferences
- `technical` - Configs, APIs, system specs
- `decision` - Architectural choices
- `person` - People info
- `project` - Goals, status, requirements
- `place` - Locations, addresses
- `entity` - Companies, tools, services

### 4. `store-facts.sh`
Generates memory_store commands from extracted facts.

```bash
./store-facts.sh facts.jsonl > commands.sh
chmod +x commands.sh
./commands.sh  # Review first!
```

### 5. `run-stats.md`
Template for tracking distillation run metrics.

## Workflow

### Step 1: Create Batches
```bash
cd /path/to/distill-sessions   # this repo or your workspace copy
./batch-sessions.sh
```

Output: `batches/batch-001.txt` through `batch-NNN.txt`

### Step 2: Extract Text from Each Batch
```bash
mkdir -p extracted
./extract-text.sh $(cat batches/batch-001.txt) > extracted/batch-001.txt
```

Repeat for each batch (or script this).

### Step 3: Process with Gemini
```bash
mkdir -p facts

openclaw sessions spawn \
  --model gemini \
  --label distill-batch-001 \
  --message "$(cat gemini-prompt.md)" \
  --attach extracted/batch-001.txt \
  > facts/batch-001.jsonl
```

Review output to ensure it's valid JSONL (not markdown-wrapped).

### Step 4: Review & Store Facts
```bash
./store-facts.sh facts/batch-001.jsonl > commands/batch-001.sh
less commands/batch-001.sh
chmod +x commands/batch-001.sh
./commands/batch-001.sh
```

### Step 5: Track Progress
Update `run-stats.md` after each batch with facts extracted, dedup results, and quality notes.

## Parallelization

```bash
# Extract all batches in parallel (8 at a time)
ls batches/*.txt | xargs -I {} -P 8 bash -c './extract-text.sh $(cat {}) > extracted/$(basename {})'
```

## Quality Control

**Before storing:**
1. Sample-check extracted facts for quality
2. Look for patterns of noise (ephemeral debugging, tool spam)
3. Refine `gemini-prompt.md` if needed
4. Deduplicate across batches

**After storing:**
1. Check memory store stats: `openclaw hybrid-mem stats`
2. Test recall: `openclaw hybrid-mem search "preference"`
3. Review entity distribution: are facts properly categorized?

## Token Budget

- **Per batch:** ~500k tokens (input to Gemini)
- **Total:** Depends on session count; e.g. ~7M tokens for ~15 batches
- **Cost estimate:** Varies by model (e.g. Gemini 3 Pro on the order of a few dollars for a full sweep)

## Expected Outcomes

- Many facts extracted across sessions; after dedup, typically 20–30% are net new (rest already in store)
- Value: fill gaps in auto-captured memory (early conversations, decisions in chat, technical configs, people info)

## Maintenance

Run this pipeline:
- **Monthly** for active usage
- **Quarterly** for light usage
- **After major projects** to capture learnings

## Troubleshooting

**"No text extracted from session"**
- Session may be pure tool calls (cron jobs, subagent tasks)
- Confirm with: `jq 'select(.type=="message") | .message.role' session.jsonl | sort | uniq -c`

**"Gemini outputs markdown instead of JSONL"**
- Emphasize "NO markdown, just JSON lines" in prompt
- Try: "Output must be valid JSONL. One fact per line. No code fences."

**"Too many low-value facts"**
- Tighten extraction criteria in prompt
- Add specific examples of what NOT to extract
- Consider post-filtering with jq

**"Facts already in store"**
- Normal! Memory auto-capture works well
- This pipeline finds what was missed
- Focus on unique insights, not duplicates
