# 🧠 OpenClaw Hybrid Memory

**An AI that actually remembers you.**

[**Documentation**](https://markus-lassfolk.github.io/openclaw-hybrid-memory/) · [GitHub](https://github.com/markus-lassfolk/openclaw-hybrid-memory)

---

> **You've been here before.** You told your AI assistant something important last week. You mentioned a preference. You made a decision. And now — it's gone. You're starting from zero. Again.

**Hybrid Memory** ends that loop. It's an OpenClaw extension that gives your agent **durable, structured, searchable memory** — so you only have to say something once.

---

## 🚀 Get Running in 30 Seconds

```bash
# 1. Install the plugin
openclaw plugins install openclaw-hybrid-memory

# 2. Apply recommended config (auto-creates 8 maintenance cron jobs)
openclaw hybrid-mem install

# 3. Configure your embedding provider in ~/.openclaw/openclaw.json
#    See: https://markus-lassfolk.github.io/openclaw-hybrid-memory/docs/LLM-AND-PROVIDERS.html

# 4. Restart and verify
openclaw gateway stop && openclaw gateway start
openclaw hybrid-mem verify
```

**That's it.** Your agent now remembers you across sessions.

Need help? → [Full Quickstart Guide](docs/QUICKSTART.md)

---

## ⚙️ Configuration Modes

Hybrid Memory comes with four built-in profiles. You can easily switch between them using the CLI:

```bash
openclaw hybrid-mem config-mode <mode>
```

### The Modes

| Mode | Description | LLM Cost | Key Features |
|------|-------------|----------|--------------|
| **`local`** | **100% Air-gapped.** (Default). Runs entirely on your machine. Uses local ONNX/Ollama embeddings and local SQLite/LanceDB. | **$0.00** | Basic storage, exact match recall, local semantic search. *Zero cloud LLM calls.* |
| **`minimal`** | **Fast & Cheap.** Basic cloud integration but turns off expensive background jobs. | **Very Low** | Cloud embeddings, basic cloud routing, no background reflection. |
| **`enhanced`** | **The Sweet Spot.** Balances intelligence with cost. | **Low** | Active RAG, background reflection, tool effectiveness tracking. |
| **`complete`** | **Maximum Intelligence.** Turns on every experimental cognitive feature. | **Medium** | Everything above + deep semantic clustering, self-correction, and autonomous skill crystallization. |

---


## 🏢 See it in Action

Curious what this looks like in practice? Check out the **[OpenClaw Personal Assistant Ecosystem](https://github.com/markus-lassfolk/openclaw-personal-assistant)**. It uses `openclaw-hybrid-memory` to build a highly proactive Executive Assistant persona that reads your emails, negotiates your calendar, and actively learns your business priorities over time.

---


## ✨ What You Actually Get

### 😤 "I already told you that"

Never again. Your agent pulls in relevant memories before every reply — your preferences, past decisions, project context, who you are. No repeating yourself. No manually pasting context.

### 🧠 It learns from how you react

When you say "perfect" or "no, do it differently" — it notices. It reinforces what worked and corrects what didn't. Over time, it gets noticeably better at giving you what you actually want.

### 📈 Gets smarter the more you use it

Every session adds to its understanding of you: your phrasing, your style, your recurring topics. After a few weeks, you get an agent that feels like it *knows* you — not a generic bot resetting to zero every time.

### 🔍 Finds what you need, even fuzzy matches

SQLite + FTS5 for instant structured lookups. LanceDB vector search for when you don't quite remember how you phrased something. Both combined via RRF merge so nothing falls through the cracks.

### 💰 Slashes Your Token Costs
Stop pasting your entire project history and guidelines into every single prompt. By running a local semantic search, Hybrid Memory only injects the strictly relevant context you need for the current turn. Your LLM context windows stay tiny, clean, and cheap.

### ⚡ Runs in the background, no babysitting

Auto-capture. Auto-recall. Background reflection. Memory decay. Cleanup. All automatic — driven by cron jobs you don't have to manage.

---

## 🎯 Core Features at a Glance

| Feature | What it does for you |
|---------|---------------------|
| **Auto-Capture** | Extracts preferences, facts, and decisions from conversations automatically |
| **Auto-Recall** | Injects relevant memories into context every turn — no prompts needed |
| **Dual Backend** | SQLite + FTS5 for fast lookups; LanceDB for semantic search |
| **Memory Tiering** | Hot/warm/cold tiers keep the most relevant facts in scope |
| **Multi-Agent Scoping** | Global, user, agent, or session scope — specialists share what they need |
| **Background Reflection** | Synthesizes patterns and rules from your accumulated facts |
| **Auto-Crystallization** | Detects recurring workflows and proposes skills — you approve before anything is written |
| **Credential Vault** | Encrypted storage for API keys and tokens — auto-injects on auth failures |
| **Write-Ahead Log** | Crash-resilient memory ops — nothing lost if something breaks |
| **TTL Decay** | Old facts expire automatically; your memory stays fresh |

For the full feature list → [FEATURES.md](docs/FEATURES.md)

---

## 🏗️ How It Works

```
You say something
       ↓
  Auto-Capture extracts facts, preferences, decisions
       ↓
  Stored in SQLite (structured) + LanceDB (vectors)
       ↓
  Next turn: Auto-Recall fetches relevant memories
       ↓
  Injected into context — your agent responds with full history
       ↓
  Background: reflection, decay, consolidation, distillation
```

See [HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) for the full walkthrough.

---

## 📋 Prerequisites

- **OpenClaw v2026.3.8+**
- **Node.js ≥22.12.0**
- **Embedding provider** (required) — e.g. OpenAI `text-embedding-3-small`, local Ollama, etc.
- **LLM access** (optional for basic memory; required for distillation, reflection, auto-classify)

See [LLM-AND-PROVIDERS.md](docs/LLM-AND-PROVIDERS.md) for setup.

---

## 📚 Documentation

### Getting Started
| Guide | What it's for |
|-------|---------------|
| **[QUICKSTART.md](docs/QUICKSTART.md)** | Install, configure, and verify — full walkthrough |
| **[HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)** | What happens each turn: auto-recall, capture, background jobs, costs |
| **[EXAMPLES.md](docs/EXAMPLES.md)** | Real-world recipes: project setup, tuning, backfilling, maintenance |
| **[FAQ.md](docs/FAQ.md)** | Cost, providers, backups, resets, troubleshooting quick answers |

### Reference
| Doc | What it's for |
|-----|---------------|
| **[CONFIGURATION.md](docs/CONFIGURATION.md)** | Full `openclaw.json` reference — every option explained |
| **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** | Four-part hybrid architecture, workspace layout, bootstrap |
| **[CLI-REFERENCE.md](docs/CLI-REFERENCE.md)** | All `openclaw hybrid-mem` commands — stats, search, classify, verify, and more |
| **[MEMORY-PROTOCOL.md](docs/MEMORY-PROTOCOL.md)** | Paste-ready AGENTS.md memory block |

### Operations
| Doc | What it's for |
|-----|---------------|
| **[OPERATIONS.md](docs/OPERATIONS.md)** | Background jobs, cron, scripts, upgrading |
| **[TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** | Common issues, diagnostics, API key quirks |
| **[BACKUP.md](docs/BACKUP.md)** | What to back up and how to restore |
| **[UNINSTALL.md](docs/UNINSTALL.md)** | Clean uninstall — revert to default memory |

### Deep Dives
| Topic | Doc |
|--------|-----|
| Memory tiering (hot/warm/cold) | [MEMORY-TIERING.md](docs/MEMORY-TIERING.md) |
| Multi-agent scoping | [MEMORY-SCOPING.md](docs/MEMORY-SCOPING.md) |
| Graph-based linking | [GRAPH-MEMORY.md](docs/GRAPH-MEMORY.md) |
| Session distillation | [SESSION-DISTILLATION.md](docs/SESSION-DISTILLATION.md) |
| Procedural memory / skill proposals | [PROCEDURAL-MEMORY.md](docs/PROCEDURAL-MEMORY.md) |
| Reflection layer | [REFLECTION.md](docs/REFLECTION.md) |
| Credential vault | [CREDENTIALS.md](docs/CREDENTIALS.md) |
| WAL crash resilience | [WAL-CRASH-RESILIENCE.md](docs/WAL-CRASH-RESILIENCE.md) |
| Decay & pruning | [DECAY-AND-PRUNING.md](docs/DECAY-AND-PRUNING.md) |
| Persona proposals | [PERSONA-PROPOSALS.md](docs/PERSONA-PROPOSALS.md) |

---

## 🛠️ Common Commands

```bash
# Verify your installation
openclaw hybrid-mem verify

# Check memory stats
openclaw hybrid-mem stats

# Search your memory
openclaw hybrid-mem search "your query here"

# Run a reflection cycle
openclaw hybrid-mem reflect

# Uninstall cleanly
openclaw hybrid-mem uninstall
```

See [CLI-REFERENCE.md](docs/CLI-REFERENCE.md) for the full command reference.

---

## 👥 Credits & Attribution

### Clawdboss.ai

[**Give Your Clawdbot Permanent Memory**](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory) (February 13, 2026)

The memory-hybrid plugin is based on this article's plugin architecture: SQLite + FTS5 for structured facts, LanceDB for semantic vector search, decay tiers with TTL-based expiry, checkpoints, and the dual-backend approach.

### ucsandman

[**OpenClaw-Hierarchical-Memory-System**](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System)

The hierarchical file memory layout (lightweight `MEMORY.md` index + drill-down detail files under `memory/`) originates from this system: the index-plus-detail-files pattern, token-budget math, and the directory structure.

### What this repo adds

This repo combines both approaches into a **unified system (v3.0)** and adds: auto-capture/recall lifecycle hooks, **memory tiering** (hot/warm/cold) and **multi-agent scoping**, **retrieval directives** and **query expansion** (#160), **LLM re-ranking** (#161), **contextual variants at index time** (#159), **multi-model embedding registry with RRF merge** (#158), **local embedding providers** (Ollama/ONNX, #153), **local LLM session pre-filtering** (#290), **future-date decay protection** (#144), **episodic event log Layer 1** (#150), **verification store** (#162), **provenance tracing** (#163), **document ingestion** (PDF/DOCX/HTML/images, #206), **workflow crystallization** (skill proposals) and **self-extension** (tool proposals), graph-based spreading activation, reflection layer, session distillation pipeline, WAL crash resilience, auto-classification with category discovery, consolidation, deduplication, credential vault, persona proposals, **scope promote** and 9 maintenance cron jobs, full CLI, verify/fix diagnostics, one-command install, clean uninstall, and upgrade helpers.
