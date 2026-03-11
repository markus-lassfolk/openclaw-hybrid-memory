---
layout: default
title: Architecture
parent: Architecture & Internals
nav_order: 1
---
# Architecture — Hybrid Memory System

Overview of the four-part memory architecture, workspace layout, and bootstrap file design.

---

## Full Hybrid Architecture

Four components work together:

| Component | What it handles | Agent action | Technology |
|-----------|------------------|--------------|------------|
| **1a. Structured facts** | "What's X's Y?" — precise lookups | None (auto); or `lookup` / tools | memory-hybrid: **SQLite + FTS5** |
| **1b. Vector recall** | "What was that thing?" — fuzzy semantic | None (auto); or `memory_store` / `memory_recall` | memory-hybrid: **LanceDB** + configurable embeddings (OpenAI, Ollama, ONNX, or Google) |
| **2. Semantic file search** | "Where did I write about X?" | None (automatic) | **memorySearch**: SQLite + BM25/vector over `memory/**/*.md` |
| **3. Hierarchical files** | "Where are we on this project?" | Manual read/write | **memory/** directory + **MEMORY.md** index |

**memory-hybrid plugin** (one plugin, two backends): SQLite+FTS5 for fast, free structured fact lookup; LanceDB for semantic conversation recall. Both auto-capture and auto-recall. **memorySearch** indexes all `memory/**/*.md` files for on-demand semantic search. **MEMORY.md** is the lightweight index (~1.5k tokens) loaded every session; detail lives in `memory/` and is drilled into on demand.

**Token discipline:** Bootstrap files (AGENTS.md, SOUL.md, MEMORY.md, etc.) are loaded every turn — keep them lean. Put reference data in `memory/**/*.md` so it's only loaded when relevant.

---

## Prerequisites (API keys and models)

- **Embedding provider (required).** The memory-hybrid plugin needs an embedding provider configured. Without valid embedding config, the plugin throws at load and does not register. Four providers are supported:
  - **OpenAI** (default): `embedding.provider: "openai"` + `embedding.apiKey`. Default model: `text-embedding-3-small` (1536d).
  - **Ollama** (local): `embedding.provider: "ollama"`. No API key required. Any Ollama model (e.g. `nomic-embed-text`).
  - **ONNX** (local): `embedding.provider: "onnx"`. No API key required. Requires `onnxruntime-node`. Models auto-downloaded from HuggingFace.
  - **Google** (Gemini API): `embedding.provider: "google"`. Uses `text-embedding-004`. Reuses `llm.providers.google.apiKey`.
  - Use `embedding.preferredProviders` for ordered failover (e.g. `["ollama", "openai"]`). See [LLM-AND-PROVIDERS.md](LLM-AND-PROVIDERS.md#embedding-providers).
  - **Embeddings are used for:** vector search (LanceDB), auto-recall, storing new facts, and CLI features (find-duplicates, consolidate).
  - **LLM features:** Auto-classify, query expansion, summarize-when-over-budget, consolidation, distillation, and reflection use **chat** models. You can configure multiple providers and model tiers (`llm.nano`, `llm.default`, `llm.heavy`) with ordered fallback lists. See [LLM-AND-PROVIDERS.md](LLM-AND-PROVIDERS.md) and [CONFIGURATION.md](CONFIGURATION.md).
- **memorySearch** (if enabled) uses the same embedding provider/model as memory-hybrid when configured.

---

## Workspace Directory Structure

Create this under your OpenClaw workspace (e.g. `~/.openclaw/workspace/`):

```text
workspace/
├── AGENTS.md              # Agent behaviour + Memory Protocol (every session)
├── SOUL.md                # Agent personality & tone (every session)
├── USER.md                # User profile (every session)
├── TOOLS.md               # Behavioural rules, quick refs (every session)
├── HEARTBEAT.md           # Periodic task checklist (every session)
├── IDENTITY.md            # Agent name/emoji (every session)
├── MEMORY.md              # Root index → links to memory/ (every session)
└── memory/
    ├── people/            # User & team profiles (permanent)
    ├── projects/          # Active project state (review every 180 days)
    ├── technical/         # Systems, APIs, integrations (review every 180 days)
    ├── companies/         # Organisation intel
    ├── decisions/         # Decision logs (YYYY-MM.md)
    ├── archive/           # Completed projects (move from projects/ when done)
    └── YYYY-MM-DD.md      # Daily logs (optional)
```

**Plugin data (memory-hybrid):** By default stores its DBs under `~/.openclaw/memory/` (SQLite `facts.db`, LanceDB dir). These are separate from the workspace `memory/` folder.

---

## What Goes Where

| Content Type | Location | Loaded When |
|-------------|----------|-------------|
| Agent personality, tone, boundaries | `SOUL.md` | Every session (bootstrap) |
| User preferences, identity | `USER.md` | Every session (bootstrap) |
| Behavioural rules, voice rules, formatting | `TOOLS.md` | Every session (bootstrap) |
| Memory index (lightweight pointers) | `MEMORY.md` | Every session (bootstrap) |
| Periodic task checklist | `HEARTBEAT.md` | Every session (bootstrap) |
| Agent name/emoji | `IDENTITY.md` | Every session (bootstrap) |
| Behaviour + Memory Protocol | `AGENTS.md` | Every session (bootstrap) |
| Technical reference (APIs, IPs, auth) | `memory/technical/*.md` | On-demand (semantic search or explicit read) |
| Project status & roadmaps | `memory/projects/*.md` | On-demand |
| People profiles | `memory/people/*.md` | On-demand |
| Decision records | `memory/decisions/*.md` | On-demand |
| Daily session logs | `memory/YYYY-MM-DD.md` | On-demand |
| Isolated facts, conversation fragments | memory-hybrid plugin (SQLite + LanceDB) | Auto-injected via autoRecall |

---

## Bootstrap vs Memory Files

**Bootstrap files** (AGENTS.md, SOUL.md, USER.md, TOOLS.md, MEMORY.md, HEARTBEAT.md, IDENTITY.md) are loaded into the system prompt **every turn**. They consume context tokens constantly. Keep them **lean**, **actionable**, and **pointer-rich**.

**Memory files** (`memory/**/*.md`) are indexed by semantic search and loaded **on demand**. They can be detailed, reference-heavy, and larger — no per-turn cost until relevant.

**Rule of thumb:** If you'd need it in every conversation → bootstrap file. If you'd need it only when working on X → memory file.

**Rules:**

- Update **MEMORY.md** whenever you add or change a file under `memory/`.
- Keep **MEMORY.md** under ~3k tokens.
- **Active Context** in MEMORY.md: list 2–5 "always load" detail files. Rotate based on what's active.

| File | Purpose | Keep small? |
|------|---------|--------------|
| **AGENTS.md** | Behaviour, safety, tools, Memory Protocol (see [MEMORY-PROTOCOL.md](MEMORY-PROTOCOL.md)) | Yes |
| **SOUL.md** | Personality, tone, boundaries | Yes |
| **USER.md** | User identity, preferences | Yes |
| **TOOLS.md** | Voice rules, formatting, index to `memory/technical/` | Yes |
| **MEMORY.md** | Index of `memory/` (Active Context, People, Projects, Technical, Decisions, Archive) | Yes — ~1.5–3k tokens |
| **HEARTBEAT.md** | Periodic checklist | Yes |
| **IDENTITY.md** | Agent name, emoji, one-line vibe | Yes |

---

## MEMORY.md Template (Root Index)

```markdown
# Long-Term Memory Index

## 🟢 Active Context
- [[memory/people/owner.md]]
- [[memory/projects/current-project.md]]

## 👥 People Index
- **Owner**: [[memory/people/owner.md]] - Short role/title.

## 🚀 Projects Index
- 🟢 **Project Name**: [[memory/projects/project-name.md]] - One-line description.
- 🟡 **Paused**: [[memory/projects/paused.md]]
- 🔵 **Completed**: [[memory/projects/completed.md]]

## 🛠 Technical Knowledge
- **System/API:** [[memory/technical/system-name.md]] - Short description.

## 🏢 Company Insights
- [[memory/companies/]] - Business profiles, partners, competitors.

## ⚖️ Decisions Log
- [[memory/decisions/YYYY-MM.md]] - Architecture & strategy decisions.

## 📚 Archived Context
- _(Links for completed/archived items.)_
```

Status emojis: 🟢 active, 🟡 paused, 🔵 completed. Keep the index under ~3k tokens.

---

## Related docs

- [DEEP-DIVE.md](DEEP-DIVE.md) — Storage internals, search algorithms, tags, links, deduplication
- [HOW-IT-WORKS.md](HOW-IT-WORKS.md) — Runtime flow (auto-recall, auto-capture)
- [QUICKSTART.md](QUICKSTART.md) — Installation and first run
- [CONFIGURATION.md](CONFIGURATION.md) — All config options
- [MEMORY-PROTOCOL.md](MEMORY-PROTOCOL.md) — AGENTS.md paste-ready block
- [FEATURES.md](FEATURES.md) — Categories, decay, tags, auto-classify
- [WAL-CRASH-RESILIENCE.md](WAL-CRASH-RESILIENCE.md) — Write-ahead log design
- [GRAPH-MEMORY.md](GRAPH-MEMORY.md) — Graph-based fact linking
- [REFLECTION.md](REFLECTION.md) — Reflection layer
