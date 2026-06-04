# MiniMax maintenance latency (A/B run 2026-06-04T10-12-56)

Measured on real Maeve fixtures (438 sessions, 120 facts). Harness used 45s default timeout unless noted.

## Reflection (60 facts in prompt)

| Model | Thinking | Latency | Result |
|-------|----------|---------|--------|
| M2.7-highspeed | adaptive | **9.0s** | ok, 7 patterns |
| M2.7-highspeed | enabled | 11.9s | ok, 7 patterns |
| M3 | disabled | 11.1s | ok, 10 patterns |
| M2.7-highspeed | disabled | 20.2s | ok, 8 patterns |
| M3 | enabled | 40.7s | ok, 20 patterns |
| **M3** | **adaptive** | **91.0s** | **timeout** at 45s default (fixed: 180s → **58s ok**, 19 patterns on re-probe) |

## Distill (~120k chars input)

| Model | Thinking | Latency | Result |
|-------|----------|---------|--------|
| M2.7-highspeed | disabled | 17.9s | ok, 12 JSONL lines |
| M2.7-highspeed | enabled | 19.0s | ok, 11 lines |
| M2.7-highspeed | adaptive | 23.0s | ok, 18 lines |
| M3 | disabled | 37.2s | ok, 14 lines |
| M3 | adaptive | 42.7s | ok, 18 lines |
| M3 | enabled | 90.9s | ok, 16 lines |

## Self-correction (1 incident)

| Model | Thinking | Latency |
|-------|----------|---------|
| M3 | disabled | 4.8s |
| M3 | enabled | 9.9s |
| M3 | adaptive | 17.4s |
| M2.7-highspeed | adaptive | 13.1s |

## Consolidation (1 cluster)

| Model | Thinking | Latency | Result |
|-------|----------|---------|--------|
| M3 | disabled | 3.7s | ok |
| M3 | adaptive | 4.7s | ok |
| M2.7-highspeed | * | 5–6s | truncated (finishReason=length) |

## Timeout defaults shipped (2026-06-04)

| Case | Timeout |
|------|---------|
| Default / non-MiniMax | 45s |
| M3, thinking off | **120s** |
| M3, thinking on | **180s** |
| M2.x, thinking on | **120s** |

On thinking timeout: retry same model with `thinking=disabled`, then maintenance fallback chain.
