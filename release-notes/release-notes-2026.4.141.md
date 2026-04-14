# Release Notes — OpenClaw Hybrid Memory 2026.4.141

**Date:** 2026-04-14  
**Previous baseline:** 2026.4.140

## Summary

**2026.4.141** ships **security** (**npm overrides** for transitive packages), **auto-classifier** fixes (**balanced JSON array** parsing for category discovery), and **maintenance cron** hardening: persisted **`id`** (aligned with **`pluginJobId`**) and **`sessionTarget: "isolated"`** for **`hybrid-mem:*`** jobs so gateway **`cron.run`** and clients using **`job.id`** stay consistent with `~/.openclaw/cron/jobs.json`. See **[CHANGELOG.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)** section **2026.4.141** for details.

---

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.4.141
```

Restart the gateway after upgrading. If you use the standalone installer package, align its version with **2026.4.141** as well. Run **`openclaw hybrid-mem verify --fix`** once to normalize existing cron rows if you rely on manual or older job definitions.

---

## Links

- [CHANGELOG (full)](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md) — search for **`2026.4.141`** for this release’s section.
