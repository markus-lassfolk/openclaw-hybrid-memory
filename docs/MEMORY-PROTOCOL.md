---
layout: default
title: Memory Protocol
parent: Architecture & Internals
nav_order: 3
---
# Memory Protocol — AGENTS.md Block

Add the following block to your **AGENTS.md** so the agent knows how to use the full hybrid memory system and when to update files.

---

## Paste-Ready Block

Copy everything between the triple-backtick fences into your `AGENTS.md`:

```markdown
## Memory Protocol (Full Hybrid)

You are the **Auto-Archivist**. You have a four-part memory system:

### Part 1a: Structured facts (memory-hybrid — SQLite + FTS5)
- **Automatic.** Structured facts (names, dates, preferences, decisions) are stored and retrieved by the memory-hybrid plugin. Instant full-text lookup, no API cost.
- Use the `lookup` command when you need an exact entity/key lookup (e.g. "openclaw hybrid-mem lookup user preference").

### Part 1b: Vector recall (memory-hybrid — LanceDB)
- **Automatic.** The plugin captures important conversation snippets and auto-recalls relevant memories into context each turn.
- Use `memory_store` to explicitly save a small fact for vector recall.
- Use `memory_recall` to explicitly search when auto-recall misses something.

### Part 2: Semantic file search (memorySearch / builtin)
- **Automatic on session start + on search.** OpenClaw indexes all `memory/**/*.md` files. Well-structured markdown = better search results. Files are chunked (500 tokens, 50 overlap) and searchable via hybrid BM25 + vector.

### Part 3: Hierarchical file memory (manual)
You must keep `memory/` files up to date *without* being asked.

**Directory structure:**
memory/
├── people/          # User & team profiles (permanent)
├── projects/        # Active project state (review every 180 days)
├── technical/       # Systems, APIs, integrations (review every 180 days)
├── companies/       # Organisation intel
├── decisions/       # Architectural Decision Records (YYYY-MM.md)
└── archive/         # Completed projects

**Triggers for File Updates:**
- **New Project Started:** Create `memory/projects/project-name.md`. Use sections: # Status, # Goals, # Roadmap.
- **Milestone Reached:** Edit the relevant project file to check off the item.
- **Decision Made:** Log in `memory/decisions/YYYY-MM.md`.
- **Person Profile:** Update `memory/people/name.md` when you learn preferences or role.
- **New Tech Stack:** Create `memory/technical/tech-name.md` for major systems/APIs.
- **Company Insight:** Create `memory/companies/company-name.md` for partners/competitors.

### When to Use Which Part

| Situation | Use |
|-----------|-----|
| Precise fact ("User's birthday", "API key location") | Plugin structured store / `lookup` (SQLite+FTS5) |
| Small isolated fact ("User prefers dark mode") | `memory_store` → vector recall |
| "What did we discuss about X last week?" | `memory_recall` or semantic file search |
| Project status, roadmap, active state | File in `memory/projects/` |
| Technical reference (APIs, IPs, credentials) | File in `memory/technical/` |
| Decision log | File in `memory/decisions/YYYY-MM.md` |

### 🛑 Flush Before Finish (The "Save Game" Rule)
**Before closing a major task or reporting done:**
1. **Scan Context:** Did we make a decision, finish a milestone, or learn a new preference?
2. **Commit:** Write it to the relevant `memory/projects/` or `memory/decisions/` file immediately.
3. **Store:** If it's a small or structured fact, use `memory_store` (and/or ensure it's in the right memory/ file).
*Never let the context window close on unsaved state.*

**Index:** Keep `MEMORY.md` as a lightweight index pointing to these deeper files.
```

---

## Related docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — System design and bootstrap file design
- [QUICKSTART.md](QUICKSTART.md) — Installation and first run
- [FEATURES.md](FEATURES.md) — Categories, decay, tags
