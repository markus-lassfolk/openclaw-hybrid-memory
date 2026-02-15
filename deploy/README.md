# Deployment artifacts for Hybrid Memory Manager v3.0

Use these with [../docs/hybrid-memory-manager-v3.md](../docs/hybrid-memory-manager-v3.md).

**Full hybrid only:** The guide implements the **full hybrid memory system** — memory-hybrid plugin (SQLite+FTS5 + LanceDB) combined with memorySearch and hierarchical **memory/** files. One installation flow applies to any system (new, a few days old, or months old).

| File | Use |
|------|-----|
| **openclaw.memory-snippet.json** | Memory-related keys to merge into `~/.openclaw/openclaw.json`. Slot is `memory-hybrid`. Replace `YOUR_OPENAI_API_KEY`. Merge under existing `agents.defaults` if needed. |
| **../docs/hybrid-memory-manager-v3.md** | Full guide: architecture (§1), directory structure (§2), plugin install (§3), config (§4), MEMORY.md template (§6), AGENTS.md Memory Protocol (§7), **deployment — one flow for any system** (§8) including optional backfill (seed + extract-daily), verification (§9), troubleshooting (§10), CLI (§11), upgrades (§12). |

**Deploy:** Follow v3 §8 in order. Optional backfill (seed script + `openclaw hybrid-mem extract-daily`) is safe to run on a new system with few memories — it won’t make things worse.

**After any OpenClaw upgrade:** Reinstall memory-hybrid deps and restart (v3 §12). Use the repo’s **scripts/** (`post-upgrade.sh`, `upgrade.sh`) and alias `openclaw-upgrade` — see [../scripts/README.md](../scripts/README.md).
