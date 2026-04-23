---
layout: default
title: Productisation Track
nav_order: 80
---

# Productisation Track (Epic #1029)

Hybrid Memory already has strong memory depth. This track exists to make that depth **easy to see, trust, and demo**.

## Goal

Make hybrid-memory feel like a first-class product: immediately understandable, inspectable, and demoable without weakening the underlying trust model.

> **Important:** [Epic #1029](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1029) is a **coordinating issue**, not one giant implementation branch. Product work lands through focused child issues.

## Current phase view

| Phase | Goal | Status | Child issues |
|---|---|---|---|
| **Phase 1 — Foundation** | Viewer, top-of-repo legibility, session visibility | **Partially shipped** | [#1023](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1023) ✅, [#1024](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1024) ✅, [#1025](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1025) open |
| **Phase 2 — Polish** | Messaging, demos, and simple public surface | **Partially shipped** | [#1027](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1027) ✅, [#1028](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1028) open |
| **Phase 3 — Maturation** | Explicit retrieval strategy and layered terminology | **Planned** | [#1026](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1026) open |

## What is already shipped

### Product entry points

- **Memory Viewer / Mission Control** via the local dashboard and viewer routes documented in `extensions/memory-hybrid/README.md` ([Issue #1023](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1023), closed)
- **README / onboarding refresh** with the capture → store → recall → inspect → control mental model, trust/privacy links, and persona-based start paths ([Issue #1024](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1024), closed)
- **Simple public API / export surface** documented at [`PUBLIC-API-SURFACE.md`](PUBLIC-API-SURFACE) (`/health`, `/search`, `/timeline`, `/stats`, `/export`) ([Issue #1027](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1027), closed)

### Trust and operator surface already available

- Local-first storage and inspection paths
- Verification, provenance, and deletion controls
- Quick start, operations, backup/restore, and trust/privacy documentation
- Session distillation and narrative docs that explain how memory is captured and reused over time

## What remains open

### [#1025](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1025) — Session timeline / observability

Still needed for the product story:
- one coherent session timeline
- capture vs injection visibility
- skipped/suppressed write explanations
- a human-readable “why this was recalled” surface

### [#1028](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1028) — Messaging, visuals, and demo story

Still needed for the presentation layer:
- tagline and elevator pitch
- hero screenshots / proof points
- 60-second and 5-minute demo scripts
- terminology cleanup for first-time readers

### [#1026](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1026) — Filter → rank → hydrate retrieval

Still needed for the explicit retrieval model:
- named constrained-search mode in code and docs
- structured filters before semantic ranking
- clearer explanation of why results matched and how they were ranked

## Recommended execution order

1. Finish **#1025** so users can inspect capture, recall, injection, and skips without log-diving.
2. Finish **#1028** so the now-visible product has a sharper story, screenshots, and demo flows.
3. Finish **#1026** so retrieval becomes a named, teachable product capability instead of an internal implementation detail.

## Guardrails for every phase

- **Local-first remains the hero path** — no hosted-memory dependency required for the baseline experience.
- **Keep the rich tool API** — the product surface should complement it, not replace it.
- **Do not weaken verification, provenance, or decay** just to make the UI or docs simpler.
- **Prefer layered explanations** — simple first, deep internals one click away.

## Related documents

- [Quick Start](QUICKSTART)
- [Public API Surface](PUBLIC-API-SURFACE)
- [How It Works](HOW-IT-WORKS)
- [Architecture](ARCHITECTURE)
- [Trust and privacy](trust-and-privacy)
