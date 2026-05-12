---
layout: default
title: Add-on ecosystem
nav_order: 81
---

# Add-on ecosystem (Phase 3 modularization)

Hybrid Memory core stays focused on durable capture, retrieval, and inspectability.
Optional capability domains should be shipped as add-ons.

## Add-on domains

- **analysis**: long-window analytics, trend detection, heavy maintenance intelligence
- **learning**: procedure/workflow learning expansions beyond core defaults
- **observability**: additional dashboards/reporting integrations
- **self-extension**: proposal generation and optional self-evolution utilities

## Design rules

1. Core must run without add-ons.
2. Add-ons consume stable internal API types (`api/memory-plugin-api.ts`).
3. Failures in add-ons must not break interactive recall.
4. Add-ons are opt-in and independently installable.

## Packaging direction

- Publish add-ons as separate npm packages.
- Keep configuration namespaced by add-on id.
- Keep feature flags explicit and default-off for non-core behavior.

## Operator workflow

1. Install core plugin.
2. Install selected add-ons by need.
3. Enable add-on config blocks explicitly.
4. Validate with `verify` / `doctor`.
