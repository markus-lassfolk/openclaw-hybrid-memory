# Release notes — OpenClaw Hybrid Memory **2026.6.272**

**Release date:** 2026-06-27  
**Since:** [2026.6.271](release-notes-2026.6.271.md)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.6.272]**

## Highlights

- **Goals & active tasks:** Protected hook stages so slow recall turns no longer silently drop goal/task injection.
- **Active-task coherence:** Auto-persist incoherent rows before injection; safer terminal inference heuristics.
- **Upgrade safety:** npm-project pin rollback restores `package.json`; workspace refresh failure rolls back the plugin install.
- **Verify:** Cold-start pending telemetry queue count; warnings for quarantined corrupt goal files.
- **`goals doctor --repair-corrupt`:** CLI to restore valid quarantined goal JSON from `*.json.corrupt`.
- **Dashboard:** Infrastructure card shows pending telemetry + quarantined goals.

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.6.272
```

Restart the gateway after upgrading. Align `openclaw-hybrid-memory-install` to **2026.6.272** if you use the installer package.

## Post-upgrade checks

- Heartbeat turn with active goals + tasks still receives goal stewardship and active-task blocks after a slow recall turn
- `openclaw hybrid-mem verify` reports pending error-reporter queue from disk when gateway is not running
- npm-project `hybrid-mem upgrade` leaves `package.json` aligned with the running plugin on failure paths
