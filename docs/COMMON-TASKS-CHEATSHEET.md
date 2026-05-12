---
layout: default
title: Common Tasks Cheatsheet
parent: Getting Started
nav_order: 3
---

# Common Tasks Cheatsheet

## Setup

```bash
openclaw plugins install openclaw-hybrid-memory
openclaw hybrid-mem install
openclaw gateway stop && openclaw gateway start
openclaw hybrid-mem verify
openclaw hybrid-mem status
```

## Day-to-day

```bash
openclaw hybrid-mem dashboard
openclaw hybrid-mem stats
openclaw hybrid-mem search "deployment"
openclaw hybrid-mem show <id>
```

## Change the experience level

```bash
openclaw hybrid-mem mode local
openclaw hybrid-mem mode minimal
openclaw hybrid-mem mode enhanced
openclaw hybrid-mem mode complete
```

## Change one setting

```bash
openclaw hybrid-mem settings
openclaw hybrid-mem set verbosity normal
openclaw hybrid-mem set nightlyCycle.enabled true
openclaw hybrid-mem help config-set autoRecall
```

## Import existing material

```bash
openclaw hybrid-mem backfill --dry-run
openclaw hybrid-mem ingest-files --dry-run
openclaw hybrid-mem distill --days 7 --dry-run
```

## Repair / diagnose

```bash
openclaw hybrid-mem preflight
openclaw hybrid-mem verify --fix
openclaw hybrid-mem repair-vectors
```
