---
layout: default
title: Credits & attribution
nav_order: 95
---

# Credits & attribution

## Clawdboss.ai

[**Give Your Clawdbot Permanent Memory**](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory) (February 13, 2026)

The memory-hybrid plugin builds on this article’s architecture: SQLite with full-text search for structured facts, LanceDB for semantic vectors, decay with TTL-style expiry, checkpoints, and a dual-backend approach.

## ucsandman

[**OpenClaw-Hierarchical-Memory-System**](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System)

The hierarchical file memory layout — a short **MEMORY.md** index plus detail files under **memory/** — comes from this system: index-plus-detail pattern, token-budget discipline, and directory layout.

## What this repository adds

This project combines those ideas into a **unified system** and extends them with:

- Auto-capture and auto-recall lifecycle hooks
- **Memory tiering** (hot / warm / cold) and **multi-agent scoping**
- **Retrieval directives** and **query expansion** ([#160](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/160))
- **LLM re-ranking** ([#161](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/161))
- **Contextual variants at index time** ([#159](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/159))
- **Multi-model embedding registry with RRF merge** ([#158](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/158))
- **Local embedding providers** (Ollama / ONNX, [#153](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/153))
- **Local LLM session pre-filtering** ([#290](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/290))
- **Future-date decay protection** ([#144](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/144))
- **Episodic event log** (layer 1, [#150](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/150))
- **Verification store** ([#162](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/162))
- **Provenance tracing** ([#163](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/163))
- **Document ingestion** (PDF / DOCX / HTML / images, [#206](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/206))
- **Workflow crystallization** (skill proposals) and **self-extension** (tool proposals)
- Graph-based spreading activation, reflection layer, session distillation pipeline
- WAL crash resilience, auto-classification with category discovery, consolidation, deduplication
- Credential vault, persona proposals, **scope promote**, bundled maintenance cron jobs
- Full CLI, verify / fix diagnostics, one-command install, clean uninstall, and upgrade helpers

For feature-level detail, see [Features](FEATURES) and [Architecture](ARCHITECTURE).
