# Follow-up: GitHub lifecycle adapter Phase 2 (#1196)

Phase 1 ships:

- `openclaw hybrid-mem entities lifecycle report`
- `openclaw hybrid-mem expire-by-source` (entity-column glob / SQL LIKE)
- Stub `services/lifecycle/github-adapter.ts` (`syncLifecycleFromGitHub` throws)
- Config `lifecycle.adapters.github` (default `enabled: false`)
- Cron job `hybrid-mem:daily-lifecycle-sync` installed **disabled**

**Phase 2**

1. Implement `syncLifecycleFromGitHub(factsDb, opts)` with real GitHub API + config validation.
2. Optionally enable the daily cron when `lifecycle.adapters.github.enabled` is true.
3. Recorded integration test against HTTP fixtures or a test repo.

Update issue #1196 to point Phase 2 work at this follow-up.
