---
layout: default
title: Home
nav_order: 1
permalink: /
---

# OpenClaw Hybrid Memory
{: .fs-9 }

Durable, structured, searchable memory for OpenClaw agents.
{: .fs-6 .fw-300 }

Your OpenClaw agent forgets everything between sessions. Hybrid Memory fixes this &mdash; it gives your agent **persistent memory** that auto-captures what matters and recalls it when relevant.
{: .fs-5 .fw-300 }

[Get Started](QUICKSTART){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[View on GitHub](https://github.com/markus-lassfolk/openclaw-hybrid-memory){: .btn .fs-5 .mb-4 .mb-md-0 }

---

## What it does

| Without hybrid memory | With hybrid memory |
|---|---|
| Agent forgets everything between sessions | Agent remembers preferences, decisions, facts |
| You repeat context every time | Auto-recall injects relevant memories each turn |
| No structured knowledge base | SQLite + FTS5 for instant structured lookups |
| No semantic search | LanceDB vector search finds contextual matches |
| Manual note-taking | Auto-capture from conversations + file-based memory |
| Stale memories never cleaned up | TTL-based decay automatically expires old facts |
| No crash protection | Write-ahead log ensures nothing is lost |

---

## Documentation

### Getting started

| Document | Description |
|----------|-------------|
| **[Quick Start](QUICKSTART)** | Install, configure, verify &mdash; get running in 10 minutes |
| **[Autonomous Setup](SETUP-AUTONOMOUS)** | Let an OpenClaw agent install it for you |
| **[Configuration](CONFIGURATION)** | Full `openclaw.json` reference |
| **[LLMs and Providers](LLM-AND-PROVIDERS)** | Prerequisites, what LLMs are used for, gateway routing, `llm` config |

### Architecture & internals

| Document | Description |
|----------|-------------|
| [Architecture](ARCHITECTURE) | Four-part hybrid architecture, workspace layout, bootstrap files |
| [How It Works](HOW-IT-WORKS) | End-to-end flow of memory capture, storage, and recall |
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
| [Search improvements (RRF, ingest, HyDE)](SEARCH-RRF-INGEST) | RRF fusion, ingest-files, HyDE query expansion |
| [Multilingual language keywords](LANGUAGE-KEYWORDS) | Auto-capture and categories in multiple languages; auto-build and build-languages |
| [Automatic Categories](AUTOMATIC-CATEGORIES) | Category discovery from "other" facts |
| [Dynamic Derived Data](DYNAMIC-DERIVED-DATA) | Index: tags, categories, decay, and other derived data |

### Operations & maintenance

| Document | Description |
|----------|-------------|
| [CLI Reference](CLI-REFERENCE) | All 34 `openclaw hybrid-mem` commands |
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
| [Feedback Roadmap](FEEDBACK-ROADMAP) | Planned improvements and feature requests |

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
