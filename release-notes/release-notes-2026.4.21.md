# Release Notes — OpenClaw Hybrid Memory 2026.4.21

**Date:** 2026-04-21  
**Previous baseline:** 2026.4.20

## Summary

**2026.4.21** aligns agent tool registration with LLM provider schemas (notably Anthropic): only underscore tool names are registered; dotted `memory.*` duplicates are removed. Documentation, issue templates, `verify-publish.cjs`, and README manual-install guidance are updated accordingly. Bumps the npm package, `openclaw.plugin.json`, and the standalone installer to **2026.4.21**.

---

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.4.21
```

Restart the gateway after upgrading.

---

## Links

- [CHANGELOG (full)](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)
