---
layout: default
title: Home
nav_order: 1
permalink: /
---

# OpenClaw Hybrid Memory
{: .fs-9 }

Local-first memory for OpenClaw that stays inspectable, trustworthy, and useful over time.
{: .fs-6 .fw-300 }

Hybrid Memory gives your OpenClaw agent **persistent memory** without turning memory into a black box. It can remember across sessions, show its work when you need proof, and stay under your control.
{: .fs-5 .fw-300 }

[Get Started](QUICKSTART){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[Scenarios & benefits](SCENARIOS){: .btn .fs-5 .mb-4 .mb-md-0 .mr-2 }
[View on GitHub](https://github.com/markus-lassfolk/openclaw-hybrid-memory){: .btn .fs-5 .mb-4 .mb-md-0 }

---

## Remember these 3 things

| What to remember | Why it matters |
|---|---|
| **Local-first by default** | Memory stays on your machine unless you deliberately choose otherwise. |
| **Inspectable and controllable** | You can verify, search, export, back up, and delete it. |
| **Hybrid retrieval** | Structured facts and semantic recall work together, so results are stronger than session-only or vector-only memory. |

---

## What it does

| Without hybrid memory | With hybrid memory |
|---|---|
| Every new thread starts from zero | Preferences, decisions, and facts carry over |
| You paste the same context again | Relevant memories can load automatically each turn |
| Hard to find “that thing we said” | Search by meaning and by structure |
| Memory becomes a junk drawer | Decay, tiering, and jobs keep storage manageable |
| Hard to tell why a memory showed up | Search, verification, provenance, and docs make recall inspectable |
| Lost work if a process crashes badly | Durable writes designed for safe recovery |

*How the engines work (SQLite, vectors, merge, WAL): [How it works](HOW-IT-WORKS) and [Architecture](ARCHITECTURE). Narrative examples: [Scenarios & benefits](SCENARIOS).*

---

## Documentation

### Getting started

| Document | Description |
|----------|-------------|
| **[Scenarios & benefits](SCENARIOS)** | Before/after diagrams and real-life stories |
| **[Quick Start](QUICKSTART)** | Install, configure, verify &mdash; get running in 10 minutes |
| **[Autonomous Setup](SETUP-AUTONOMOUS)** | Let an OpenClaw agent install it for you |
| **[Configuration](CONFIGURATION)** | Full `openclaw.json` reference |
| **[LLMs and Providers](LLM-AND-PROVIDERS)** | Prerequisites, what LLMs are used for, gateway routing, `llm` config |

### Architecture & internals

| Document | Description |
|----------|-------------|
| [Architecture](ARCHITECTURE) | Four-part hybrid architecture, workspace layout, bootstrap files |
| [Architecture Center](ARCHITECTURE-CENTER) | Architecture anchor: core runtime boundary vs adjacent subsystems |
| [How It Works](HOW-IT-WORKS) | End-to-end flow of memory capture, storage, and recall |
| [Retrieval Modes](RETRIEVAL-MODES) | Ownership and contracts for interactive vs explicit/deep retrieval paths |
| [Memory Protocol](MEMORY-PROTOCOL) | Paste-ready AGENTS.md block |

### Features

| Document | Description |
|----------|-------------|
| [Features Overview](FEATURES) | Categories, decay, tags, auto-classify, source dates |
| [Credential Vault](CREDENTIALS) | Opt-in encrypted storage for API keys, tokens, passwords |
| [Session Distillation](SESSION-DISTILLATION) | Extracting durable facts from old conversation logs |
| [Graph Memory](GRAPH-MEMORY) | Graph-based fact linking and spreading activation |
| [WAL Crash Resilience](WAL-CRASH-RESILIENCE) | Write-ahead log design and recovery |
| [Reflection Layer](REFLECTION) | Pattern synthesis from accumulated facts |
| [Conflicting Memories](CONFLICTING-MEMORIES) | Classify-before-write, supersession, bi-temporal |
| [Memory Tiering](MEMORY-TIERING) | Hot/warm/cold tiers, compaction, session-end hooks |
| [Memory Scoping](MEMORY-SCOPING) | Global, user, agent, session scope; multi-agent; scope promote |
| [Search improvements (RRF, ingest, query expansion)](SEARCH-RRF-INGEST) | RRF fusion, ingest-files, query expansion |
| [Multilingual language keywords](LANGUAGE-KEYWORDS) | Auto-capture and categories in multiple languages; auto-build and build-languages |
| [Automatic Categories](AUTOMATIC-CATEGORIES) | Category discovery from "other" facts |
| [Dynamic Derived Data](DYNAMIC-DERIVED-DATA) | Index: tags, categories, decay, and other derived data |

### Operations & maintenance

| Document | Description |
|----------|-------------|
| [CLI Reference](CLI-REFERENCE) | All `openclaw hybrid-mem` commands by category |
| [Operations](OPERATIONS) | Day-to-day operational procedures |
| [Uninstall](UNINSTALL) | Revert to default memory; optional data removal |
| [Upgrade OpenClaw](UPGRADE-OPENCLAW) | What to do after every OpenClaw upgrade |
| [Upgrade Plugin](UPGRADE-PLUGIN) | Upgrading the hybrid-memory plugin |
| [Backup](BACKUP) | What to back up and how to restore |
| [Maintenance](MAINTENANCE) | File hygiene, periodic review, upgrades |
| [Troubleshooting](TROUBLESHOOTING) | Common issues, API key behaviour, diagnostics |

### Analysis & planning

| Document | Description |
|----------|-------------|
| [Model-Agnostic Analysis](MODEL-AGNOSTIC-ANALYSIS) | Compatibility across LLM providers |
| [Presentation strategy](PRESENTATION-STRATEGY) | Canonical product message, demo story, visuals, and terminology |
| [Feedback Roadmap](FEEDBACK-ROADMAP) | Planned improvements and feature requests |
| [Productisation Track](PRODUCTISATION-TRACK) | Coordinating view of shipped product work, open lanes, and phase order |

### Project

| Document | Description |
|----------|-------------|
| [Credits & attribution](CREDITS-AND-ATTRIBUTION) | Sources, lineage, and what this repository adds |

---

## Architecture at a glance

```
┌─────────────────────────────────────────────────┐
│                 OpenClaw Agent                  │
├─────────────────────────────────────────────────┤
│            Hybrid Memory Manager                │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ SQLite + │  │ LanceDB  │  │ Hierarchical │  │
│  │   FTS5   │  │ Vectors  │  │    Files     │  │
│  └──────────┘  └──────────┘  └──────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │   WAL    │  │  Graph   │  │  Reflection  │  │
│  │  Layer   │  │  Memory  │  │    Layer     │  │
│  └──────────┘  └──────────┘  └──────────────┘  │
└─────────────────────────────────────────────────┘
```

---

## Quick start

```bash
# 1. Install the plugin
openclaw plugins install openclaw-hybrid-memory

# 2. Apply recommended config
openclaw hybrid-mem install

# 3. Set your OpenAI API key in ~/.openclaw/openclaw.json

# 4. Restart and verify
openclaw gateway stop && openclaw gateway start
openclaw hybrid-mem verify
```
