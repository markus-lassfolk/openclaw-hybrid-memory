# Release notes — OpenClaw Hybrid Memory **2026.6.271**

**Release date:** 2026-06-27  
**Since:** [2026.6.270](release-notes-2026.6.270.md)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.6.271]**

## Highlights

- **Upgrade reliability:** npm-project and extensions layouts upgrade to the correct plugin path; bundled skill/TOOLS verification gates success; workspace refresh failures are fatal.
- **Maintenance ops:** Grouped `maintenance analyze-logs` in cron templates; validate-exit distinguishes wrapper abort from missing steps.
- **Goal stewardship:** `goal_assess` handles corrupt goal JSON and missing args without crashing; corrupt goal files quarantined to stop telemetry spam.
- **Reliability:** Episode failure contradiction SQL fix; error-reporter adaptive flush/dedupe; before_agent_start gateway budget; workboard shutdown suppression.

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.6.271
```

Restart the gateway after upgrading. Align `openclaw-hybrid-memory-install` to **2026.6.271** if you use the installer package.

## Post-upgrade checks

- `openclaw hybrid-mem upgrade <ver>` on npm-project installs leaves `node_modules/openclaw-hybrid-memory` intact with bundled skill + TOOLS snippet
- `openclaw hybrid-mem verify --fix` refreshes stale `analyze-maintenance-logs` cron messages
- `goal_assess` on a corrupt goal file returns a readable error instead of a plugin crash
