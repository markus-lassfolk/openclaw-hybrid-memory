---
layout: default
title: Demo package
nav_order: 13
---

# Demo package

This package provides repeatable scripts for product demos and social proof.

## 60-second demo

1. Store a preference and ownership fact.
2. Ask a follow-up in a fresh context.
3. Show immediate proof with:
   - `openclaw hybrid-mem search "..."`
   - `openclaw hybrid-mem stats`
4. Close with:
   - local-first
   - inspectable
   - structured + semantic recall

## 5-minute operator demo

1. Install + verify:
   - `openclaw plugins install openclaw-hybrid-memory`
   - `openclaw hybrid-mem install`
   - `openclaw hybrid-mem doctor --fix`
2. Show session observability:
   - `openclaw hybrid-mem audit session --format summary`
   - `openclaw hybrid-mem audit session --format timeline --limit 30`
3. Show constrained retrieval:
   - run `memory_recall` with `retrievalMode: "constrained-recall"` and filters
4. Show operations and trust controls:
   - `openclaw hybrid-mem audit health --strict --json`
   - `openclaw hybrid-mem benchmark report --out /tmp/hm-benchmark.md`
   - backup/export/delete paths

## Social/demo assets

- Hero screenshot: Mission Control overview
- Proof screenshot: recall explanation + observability timeline
- Operator screenshot: health + benchmark report
- 10–20 second clips:
  - “stores once, recalls later”
  - “why recalled” visibility
  - “local-first controls”

## Suggested publishing cadence

- Weekly: one short feature clip
- Monthly: one operator deep dive
- Release-day: benchmark report + changelog highlights
