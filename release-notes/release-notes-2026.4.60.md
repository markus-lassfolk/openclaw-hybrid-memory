# Release Notes — OpenClaw Hybrid Memory 2026.4.60

**Date:** 2026-04-06  
**Previous baseline:** 2026.4.52

## Summary

**2026.4.60** adds **first-class OpenAI Responses API** support for plugin LLM calls (`responses.create`), including the **`azure-foundry-responses/`** model prefix, routing through **`chatComplete`** and the **multi-provider OpenAI proxy**, **cost tracking** and **feature labeling** for Responses-shaped requests, **`verify --test-llm`** coverage, and **documentation** for Azure Foundry Responses-only deployments. Also includes a **procedures DB test** CI flake fix.

For issue context and the full change list, see **[CHANGELOG.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)** (section **2026.4.60**).

---

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.4.60
```

Restart the gateway after upgrading. If you use the standalone installer package, align its version with **2026.4.60** as well.

---

## Links

- [CHANGELOG (full)](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md) — search for **`2026.4.60`** for this release’s section.
