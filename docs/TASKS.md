---
layout: default
title: Tasks
parent: Getting Started
nav_order: 2
---

# I want to...

| Goal | Start here |
|---|---|
| Install and get a safe default setup | [Quick Start](QUICKSTART.md) + `openclaw hybrid-mem install` |
| See whether the plugin is healthy | `openclaw hybrid-mem status` then `openclaw hybrid-mem verify` |
| Open the dashboard | `openclaw hybrid-mem dashboard` |
| Pick the right preset | [Configuration Modes](CONFIGURATION-MODES.md) |
| Change one setting | `openclaw hybrid-mem config` / `config-set` |
| Import existing notes or docs | `openclaw hybrid-mem backfill` / `ingest-files` |
| Inspect what memory exists | `openclaw hybrid-mem stats`, `search`, `show`, or the dashboard |
| Fix setup problems | [Troubleshooting](TROUBLESHOOTING.md) + `openclaw hybrid-mem verify --fix` |
| Learn the full command set | [CLI Reference](CLI-REFERENCE.md) |
| Understand the architecture | [How It Works](HOW-IT-WORKS.md) and [Architecture](ARCHITECTURE.md) |

## Fast path for new users

1. `openclaw plugins install openclaw-hybrid-memory`
2. `openclaw hybrid-mem install`
3. Restart the gateway
4. `openclaw hybrid-mem verify`
5. `openclaw hybrid-mem status`
6. `openclaw hybrid-mem dashboard`
