# MiniMax maintenance A/B — quality-first policy

Scheduled maintenance runs in the background; **output quality and reliability beat latency** unless two configs produce similar results or jobs fail to keep up with the queue.

## Scoring policy (`decide.ts`)

1. **Gates:** `ok`, parse failures, truncations, `finishReason=length`, coverage %
2. **Richness:** pattern count (reflection), JSONL lines (distill), merged chars (consolidation), coverage (incident tasks)
3. **Tie-break only:** latency (~1 point per minute, max 5)

## Validated run: 2026-06-04T10-42-51

Corpus: 438 sessions, 1 SC incident, 0 reinforcement, 120 facts. Timeouts: M3 120–180s + thinking downgrade fallback.

### Quality-first winners

| Task | Winner | Quality signal | Latency | Notes |
|------|--------|----------------|---------|-------|
| self-correction | **M3** disabled | 100% coverage | 2s | JSON task — thinking off |
| consolidation | **M3** disabled | ok, no truncation | 3.5s | M2.7 truncates (`length`) |
| reflection | **M3** enabled/adaptive | **17–18** patterns | 57–75s | M2.7 only 6–7 patterns |
| distill | **M3** disabled/enabled | **19–20** JSONL lines | 45–68s | M2.7 only 7–12 lines |
| reinforcement | **M2.7** disabled | (skipped — 0 incidents) | — | Hypothesis; re-test with incidents |

### Reflection (quality comparison)

| Model | Thinking | Patterns | Latency |
|-------|----------|----------|---------|
| **M3** | enabled | **18** | 75s |
| **M3** | adaptive | **17** | 57s |
| M3 | disabled | 8 | 14s |
| M2.7-highspeed | disabled | 7 | 17s |
| M2.7-highspeed | adaptive | 6 | 16s |

**Ship:** M3 + adaptive (quality near peak; user preference for adaptive thinking).

### Distill (~120k chars)

| Model | Thinking | JSONL lines | Latency |
|-------|----------|-------------|---------|
| **M3** | enabled | **20** | 68s |
| **M3** | disabled | **19** | 45s |
| M2.7-highspeed | disabled | 12 | 18s |

**Ship:** M3 on maintenance tier (`distill.modelTier=maintenance`), thinking disabled (JSON extraction; nearly same line count as enabled).

### Consolidation

M3 all cells score ok. M2.7-highspeed hits output cap (`finishReason=length`) — quality failure, not a speed tradeoff.

## Timeout defaults (reliability, not speed)

| Case | Timeout |
|------|---------|
| Default / non-MiniMax | 45s |
| M3, thinking off | **120s** |
| M3, thinking on | **180s** |
| M2.x, thinking on | **120s** |

On thinking timeout: retry same model with `thinking=disabled`, then maintenance fallback chain.

## When latency *does* matter

Only if incremental maintenance runs **fail to finish** before the next cron fire (queue grows). Mitigations: run weekly/monthly more often, cap batch sizes, monitor wall-clock per job — not downgrade model for 50s vs 5s per LLM call.
