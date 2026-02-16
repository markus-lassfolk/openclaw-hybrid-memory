# Session Distillation Run Stats

**Run Date:** YYYY-MM-DD  
**Operator:** [Your Name]  
**Sessions Analyzed:** [Total]  
**Model Used:** Gemini 3 Pro (or your chosen model)

---

## Batch Processing

| Batch | Sessions | Tokens Est. | Facts Extracted | Deduped | Duration | Notes |
|-------|----------|-------------|-----------------|---------|----------|-------|
| 001   | 50       | ~450k       | -               | -       | -        |       |
| 002   | 50       | ~480k       | -               | -       | -        |       |
| 003   | 50       | ~470k       | -               | -       | -        |       |
| ...   | ...      | ...         | ...             | ...     | ...      | ...   |

**Total Batches:** -  
**Total Processing Time:** -

---

## Extraction Summary

### Facts by Category

| Category   | Extracted | After Global Dedup | Already in Store | New Facts Stored |
|------------|-----------|--------------------|--------------------|------------------|
| preference | -         | -                  | -                  | -                |
| technical  | -         | -                  | -                  | -                |
| decision   | -         | -                  | -                  | -                |
| person     | -         | -                  | -                  | -                |
| project    | -         | -                  | -                  | -                |
| place      | -         | -                  | -                  | -                |
| entity     | -         | -                  | -                  | -                |
| **TOTAL**  | **-**     | **-**              | **-**              | **-**            |

---

## Quality Assessment

### Top Entities by Fact Count
1. [Entity Name] - [N] facts
2. [Entity Name] - [N] facts
3. [Entity Name] - [N] facts
...

### Most Valuable Extractions
- **[Category]:** [Brief description of most impactful fact]
- **[Category]:** [Brief description]
- **[Category]:** [Brief description]

### Noise/Low-Value Patterns Found
- [Pattern description - e.g., "too many ephemeral debugging facts"]
- [Pattern description]

### Prompt Refinements Needed
- [ ] [Adjustment 1 - e.g., "Better filtering of tool call logs"]
- [ ] [Adjustment 2]

---

## Coverage Analysis

### Session Date Range
- **Oldest:** YYYY-MM-DD
- **Newest:** YYYY-MM-DD
- **Span:** N months

### Session Types Covered
- [x] Main chat sessions
- [x] Subagent sessions
- [ ] Voice interactions (if applicable)
- [ ] Group chat sessions (if applicable)

---

## Issues & Observations

### Technical Issues
- [Issue description]
- [Issue description]

### Interesting Findings
- [Observation about conversation patterns]
- [Observation about knowledge gaps]

### Memory Store Health
- **Before distillation:** [N] facts
- **After distillation:** [N] facts
- **Growth:** +[N] facts (+X%)

---

## Next Steps

- [ ] Review high-confidence facts for accuracy
- [ ] Merge duplicate entities (e.g., name casing)
- [ ] Update project files in `memory/projects/` based on extracted project facts
- [ ] Archive session JSONL files that have been successfully distilled
- [ ] Schedule next distillation run (recommend: monthly for active sessions)

---

## Command Log

```bash
# Batch creation
./batch-sessions.sh
# → Created N batches

# Example extraction (batch 001)
./extract-text.sh $(cat batches/batch-001.txt) > extracted/batch-001.txt

# Example Gemini processing
openclaw sessions spawn --model gemini --label distill-batch-001 \
  --message "$(cat gemini-prompt.md)" \
  --attach extracted/batch-001.txt > facts/batch-001.jsonl

# Store facts
./store-facts.sh facts/batch-001.jsonl > commands/batch-001.sh
chmod +x commands/batch-001.sh
./commands/batch-001.sh
```

---

**Conclusion:**  
[Overall assessment of the distillation run - was it worth it? What did we learn?]
