# Hybrid Memory Manager — Version 3.0

**Version:** 3.0  
**Date:** 2026-02-17

Single deployment-ready reference for the **full hybrid memory system**: vector/DB (memory-hybrid) combined with file-based memory (memorySearch + hierarchical `memory/` files).

This document unifies:

- **Current setup** (hybrid-hierarchical memory from `hybrid-hierarchical-memory-guide.md` v2.0, see [archive](../archive/))
- **ucsandman** [OpenClaw-Hierarchical-Memory-System](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System): index + drill-down, token math, safeguards
- **Clawdboss.ai** [Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory): **memory-hybrid** plugin (SQLite+FTS5+LanceDB), decay, checkpoints

---

## Documentation

The full documentation is split into focused guides for easy navigation:

| Document | What it covers |
|----------|---------------|
| **[QUICKSTART.md](../QUICKSTART.md)** | Install the plugin, apply config, verify — get running in 10 minutes |
| **[ARCHITECTURE.md](../ARCHITECTURE.md)** | Four-part hybrid architecture, workspace layout, bootstrap vs memory files, MEMORY.md template |
| **[CONFIGURATION.md](../CONFIGURATION.md)** | All `openclaw.json` settings: plugin config, memorySearch, compaction, auto-recall, bootstrap limits |
| **[FEATURES.md](../FEATURES.md)** | Categories, classification pipeline, decay & pruning, auto-classify, source dates, auto-tagging |
| **[CLI-REFERENCE.md](../CLI-REFERENCE.md)** | All `openclaw hybrid-mem` commands with options |
| **[MEMORY-PROTOCOL.md](../MEMORY-PROTOCOL.md)** | Paste-ready AGENTS.md block for the Memory Protocol |
| **[TROUBLESHOOTING.md](../TROUBLESHOOTING.md)** | Common issues, API key behaviour, diagnostic commands |
| **[MAINTENANCE.md](../MAINTENANCE.md)** | File hygiene, periodic review, deployment flow, upgrading OpenClaw |

### Other docs

| Document | What it covers |
|----------|---------------|
| [CREDENTIALS.md](../CREDENTIALS.md) | Credentials vault (opt-in encrypted credential store) |
| [SESSION-DISTILLATION.md](../SESSION-DISTILLATION.md) | Extracting facts from session logs |
| [GRAPH-MEMORY.md](../GRAPH-MEMORY.md) | Graph memory / fact linking |
| [WAL-CRASH-RESILIENCE.md](../WAL-CRASH-RESILIENCE.md) | Write-ahead log design |
| [SETUP-AUTONOMOUS.md](../SETUP-AUTONOMOUS.md) | AI-friendly setup (imperative phase-by-phase for agents) |
| [REFLECTION.md](../REFLECTION.md) | Reflection system |
| [MODEL-AGNOSTIC-ANALYSIS.md](../MODEL-AGNOSTIC-ANALYSIS.md) | Analysis of multi-provider support options |
| [FEEDBACK-ROADMAP.md](../FEEDBACK-ROADMAP.md) | Post-PR #15 feedback roadmap (completed) |

---

## Quick Start

```bash
# 1. Copy extensions/memory-hybrid/ to your OpenClaw extensions directory
# 2. Install deps in extension dir
cd /usr/lib/node_modules/openclaw/extensions/memory-hybrid && npm install

# 3. Apply recommended config
openclaw hybrid-mem install

# 4. Set your API key in ~/.openclaw/openclaw.json

# 5. Restart
openclaw gateway stop && openclaw gateway start

# 6. Verify
openclaw hybrid-mem verify
```

See [QUICKSTART.md](../QUICKSTART.md) for the full walkthrough.

---

## Architecture at a Glance

| Component | Technology | Agent action |
|-----------|------------|--------------|
| Structured facts | SQLite + FTS5 | Auto / `lookup` |
| Vector recall | LanceDB + OpenAI embeddings | Auto / `memory_store` / `memory_recall` |
| Semantic file search | memorySearch (BM25 + vector) | Automatic |
| Hierarchical files | `memory/` directory + `MEMORY.md` | Manual read/write |

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the full design.

---

**Sources:** hybrid-hierarchical-memory-guide.md (v2.0), [ucsandman/OpenClaw-Hierarchical-Memory-System](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System), [Clawdboss.ai — Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory).
