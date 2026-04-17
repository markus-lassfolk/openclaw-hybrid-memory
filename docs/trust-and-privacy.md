# Trust and Privacy

Hybrid Memory is designed so memory feels like a system you can trust, not a black box you hope is behaving.

**Short version:** local-first by default, inspectable when you need proof, and controllable across backup, export, and deletion paths.

## Local-first by default

- Memory data is stored on your machine unless you configure external providers.
- Core persistence uses local SQLite and local vector storage.
- Feature depth depends on your configured providers and mode.
- Hosted services can still be part of your setup, but the default trust model is local-first.

## What gets remembered

Depending on enabled capabilities, the system may retain:
- Facts and preferences from conversation
- Decisions and task outcomes
- Procedures and workflow hints
- Issues/episodes and derived summaries

## Inspectable by design

Use these commands to inspect system health and memory behavior:

```bash
openclaw hybrid-mem verify
openclaw hybrid-mem stats
openclaw hybrid-mem search "query"
```

For deeper operational checks: [OPERATIONS.md](OPERATIONS.md), [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

The important point is not only that memory exists — it is that you have proof paths when you need them.

## Control, backup, and deletion

Use documented CLI paths to remove plugin state and memory artifacts:

```bash
openclaw hybrid-mem uninstall
```

Before deletion, consider backup/export:

```bash
openclaw hybrid-mem backup --dest ./backup
openclaw hybrid-mem export --help
```

References:
- [UNINSTALL.md](UNINSTALL.md)
- [BACKUP.md](BACKUP.md)
- [OPERATIONS.md](OPERATIONS.md)

## Trust checklist

- [ ] I know where memory is stored.
- [ ] I can run `verify` and `stats` successfully.
- [ ] I can search and inspect what is recalled.
- [ ] I have a tested backup and restore workflow.
- [ ] I know my deletion path (`uninstall` + cleanup docs).
- [ ] I can explain why this setup is local-first and how I would audit it.
