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

Your OpenClaw agent forgets everything between sessions. Hybrid Memory fixes this — it gives your agent **persistent memory** that auto-captures what matters and recalls it when relevant.
{: .fs-5 .fw-300 }

[Get Started](hybrid-memory-manager-v3){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
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

### Core

| Document | Description |
|----------|-------------|
| **[Deployment Guide](hybrid-memory-manager-v3)** | Full v3 deployment guide — install, configure, verify |
| **[Setup (Autonomous)](SETUP-AUTONOMOUS)** | Let an OpenClaw agent install it for you |

### Features

| Document | Description |
|----------|-------------|
| [Credential Vault](CREDENTIALS) | Opt-in encrypted storage for API keys, tokens, passwords |
| [Session Distillation](SESSION-DISTILLATION) | Extracting durable facts from old conversation logs |
| [Graph Memory](GRAPH-MEMORY) | Graph-based fact linking and spreading activation |
| [WAL Crash Resilience](WAL-CRASH-RESILIENCE) | Write-ahead log design and recovery |
| [Reflection Layer](REFLECTION) | Pattern synthesis from accumulated facts |

### Analysis

| Document | Description |
|----------|-------------|
| [Model-Agnostic Analysis](MODEL-AGNOSTIC-ANALYSIS) | Compatibility across LLM providers |

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
