# Release Notes — OpenClaw Hybrid Memory 2026.4.30

**Date:** 2026-04-30  
**Previous baseline:** 2026.4.21

## Summary

**2026.4.30** is a feature and reliability release. It adds **entity-aware memory** (people and organizations, multilingual detection), improves **embedding and verify** flows (including Azure Foundry edge cases), **re-injects recall after compaction** so the last user turn stays grounded in memory, aligns **cron / verify** checks with your **main agent** model when using `agents.list`, and tightens **cost labels** on LLM calls for clearer dashboards. Documentation, plugin help text, and the hybrid-memory **skill** are updated so you can configure and troubleshoot without digging through code.

---

## What’s new (high level)

| Area | What you get |
|------|----------------|
| **Entities & graph** | With `graph.enabled`, the plugin can extract **PERSON** / **ORG** spans, store them in SQLite, and expose **`memory_directory`** (`list_contacts`, `org_view`). Use **`openclaw hybrid-mem enrich-entities`** to backfill. Cron templates include nightly/monthly steps. |
| **After compaction** | When memory is compacted, the plugin can **re-run recall** on your **last user message** and prepend **`<recalled-context>`** so the assistant does not lose thread. |
| **Re-index** | **`--delay-ms-between-batches`** spaces out embedding batches to ease **rate limits** on large re-index jobs. |
| **Verify & cron** | **`verify`** uses the same idea of “primary chat model” as your **main** agent entry in `agents.list` when present, reducing false “model mismatch” noise between cron and chat. |
| **Costs** | Reflection and related LLM paths use **stable feature labels** so cost attribution stays consistent. |
| **Ops** | Troubleshooting covers **embedding init**, **quotas**, Azure **400** responses, and re-index throttling; plugin JSON includes clearer **LLM tier** help. |

For issue links and the full list, see **[CHANGELOG.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)** (section **2026.4.30**).

---

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.4.30
```

Restart the gateway after upgrading.

If you use the plugin from a checkout or tarball, update the `extensions/memory-hybrid` dependency to this version and restart OpenClaw.

---

## Links

- [CHANGELOG (full)](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)
