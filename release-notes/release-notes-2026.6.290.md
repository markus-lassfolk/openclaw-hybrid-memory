# Release notes — OpenClaw Hybrid Memory **2026.6.290**

**Release date:** 2026-06-29  
**Since:** [2026.6.276](../CHANGELOG.md#20266276---2026-06-27)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.6.290]**

## Highlights

- **Persona rule router (#2002):** Routes operational rules to the correct authority file (`AGENTS.md`, `TOOLS.md`, etc.), blocks semantic duplicates and cross-file matches, and surfaces contradiction evidence before proposals are created or auto-applied.

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.6.290
```

Restart the gateway after upgrading. Align `openclaw-hybrid-memory-install` to **2026.6.290** if you use the installer package.

## Post-upgrade checks

- A GitHub/issue-workflow rule proposed against `SOUL.md` surfaces an advisory retarget suggestion to `AGENTS.md`
- `personaProposals.personaRuleRouting.routingMode: advisory` (default) keeps existing callers working; set `enforce` to block misrouted proposals
