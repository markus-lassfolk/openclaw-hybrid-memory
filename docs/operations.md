# Operations

Use this guide for stable day-2 operation of Hybrid Memory.

## Who this is for

- Serious operator
- Production-ish personal deployment
- Teams that need predictable maintenance and recoverability

## Daily/weekly routine

```bash
openclaw hybrid-mem verify
openclaw hybrid-mem stats
```

If verification reports repairable issues:

```bash
openclaw hybrid-mem verify --fix
```

## Backup and restore

Backup before upgrades, major config changes, and cleanup operations.

```bash
openclaw hybrid-mem backup --output ./backup
```

Use restore steps from:
- [BACKUP.md](BACKUP.md)
- [OPERATIONS.md](OPERATIONS.md)

## Upgrades

- Follow [UPGRADE-PLUGIN.md](UPGRADE-PLUGIN.md)
- Re-run verification after upgrade
- Confirm scheduled jobs and provider alignment

## Troubleshooting entry points

- [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- [ERROR-REPORTING.md](ERROR-REPORTING.md)
- [CLI-REFERENCE.md](CLI-REFERENCE.md)

## Operational deep dives

- [OPERATIONS-MAINTENANCE.md](OPERATIONS-MAINTENANCE.md)
- [MAINTENANCE.md](MAINTENANCE.md)
- [MAINTENANCE-TASKS-MATRIX.md](MAINTENANCE-TASKS-MATRIX.md)
