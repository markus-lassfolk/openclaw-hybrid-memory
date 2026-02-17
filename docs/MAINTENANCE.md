# Maintenance — File Hygiene, Reviews, and Upgrades

How to keep the memory system healthy over time.

---

## Writing Effective Memory Files

Memory files are your searchable corpus. Their quality directly affects recall quality.

### Good practices

1. **Use clear headings** — `## API Access`, `## Camera Names` — these become search anchors.
2. **Front-load key info** — put the most important facts in the first few lines.
3. **Use consistent naming** — e.g. `memory/technical/frigate.md` rather than long ad-hoc names.
4. **Include keywords** — if someone might search "Frigate password", make sure both words appear near each other.
5. **Keep files focused** — one topic per file; avoid mega-docs.
6. **Use tables for structured data** — camera lists, entity IDs, API endpoints chunk better than long prose.

### Bad practices

- Huge monolithic files (>5000 chars) — harder to chunk meaningfully.
- Files with only links and no content — nothing to embed.
- Duplicating info across files — creates conflicting search results.
- Stale files never reviewed — outdated info pollutes recall.
- Putting reference data in bootstrap files — wastes context tokens every turn.

### File size guidelines

| File type | Target size | Why |
|-----------|-------------|-----|
| Bootstrap files (TOOLS.md, MEMORY.md, etc.) | <3000 chars | Loaded every turn, context cost |
| Memory files (technical, projects) | 500–3000 chars | Fits well in 500-token chunks |
| Decision logs | Any size | Append-only, searched by date |
| People profiles | 500–1500 chars | Focused, rarely massive |

---

## Periodic Review

Use your HEARTBEAT.md checklist or a periodic reminder:

1. Read recent `memory/YYYY-MM-DD.md` daily files.
2. Identify significant events, lessons, insights worth keeping long-term.
3. Update relevant `memory/` files with distilled learnings.
4. Update `MEMORY.md` index if new files were created.
5. Remove outdated info from files that's no longer relevant.
6. Archive completed projects: move from `memory/projects/` to `memory/archive/`.

### MEMORY.md as root index

Keep it as a **lightweight pointer file**: links to active projects, people, technical docs; status emojis. No detailed content — just enough to orient the agent. Keep under ~3k tokens.

### Daily files (`memory/YYYY-MM-DD.md`)

Raw session logs. Write what happened, decisions made, issues found. Searchable via memorySearch, source material for periodic reviews, not loaded at bootstrap.

---

## Deploying to a New or Existing System

Use this flow whether the system is brand new, a few days old, or has been running for months:

1. **Workspace:** Create or use workspace root.
2. **memory/ layout:** Create subdirs: `people/`, `projects/`, `technical/`, `companies/`, `decisions/`, `archive/`.
3. **Bootstrap files:** Create or update AGENTS.md (include [Memory Protocol](MEMORY-PROTOCOL.md)), SOUL.md, USER.md, TOOLS.md, MEMORY.md, HEARTBEAT.md, IDENTITY.md.
4. **Plugin:** Install per [QUICKSTART.md](QUICKSTART.md).
5. **Config:** Merge [CONFIGURATION.md](CONFIGURATION.md) settings into `openclaw.json`.
6. **Restart:** `openclaw gateway stop` then `openclaw gateway start`.
7. **Optional — Backfill:** See [QUICKSTART.md](QUICKSTART.md) § Backfill.
8. **Verify:** `openclaw hybrid-mem verify`.

### Backfill from session logs

If you've been running OpenClaw without memory files, spawn a sub-agent:

> "Scan my recent session logs (last 30 days) at `~/.openclaw/agents/main/sessions/`. Create `memory/projects/`, `memory/technical/`, `memory/people/`, and `memory/companies/` files from what you find. Update `MEMORY.md` index."

Then run the backfill script to seed the plugin DBs from the new files.

---

## Upgrading OpenClaw

**Important:** After every OpenClaw upgrade (e.g. `npm update -g openclaw`), the memory-hybrid plugin's native dependencies can break. You must **reinstall extension deps and restart the gateway**.

### Recommended: upgrade scripts + alias

1. Copy `scripts/post-upgrade.sh` and `scripts/upgrade.sh` from this repo into `~/.openclaw/scripts/`.
2. Make executable: `chmod +x ~/.openclaw/scripts/*.sh`
3. Add alias to `~/.bashrc`:
   ```bash
   alias openclaw-upgrade='~/.openclaw/scripts/upgrade.sh'
   ```
4. Run `openclaw-upgrade` for one-command upgrades.

### Why this is needed

Global npm upgrades reinstall the top-level `openclaw` package without re-running `npm install` inside extension directories. The plugin depends on native modules (`better-sqlite3`, `@lancedb/lancedb`) that need to be reinstalled in the extension dir.

If you upgrade by other means, run `~/.openclaw/scripts/post-upgrade.sh` manually, then restart.

---

## Related docs

- [QUICKSTART.md](QUICKSTART.md) — Installation
- [CONFIGURATION.md](CONFIGURATION.md) — Config reference
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — Common issues
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — All CLI commands
- [ARCHITECTURE.md](ARCHITECTURE.md) — System design
