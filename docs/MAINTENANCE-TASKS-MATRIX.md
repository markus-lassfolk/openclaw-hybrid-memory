# Maintenance tasks: when they run

This matrix shows **which maintenance tasks run** in each context (installation, update, restart, scheduled jobs, and `run-all`). Use it to see gaps or overlaps and decide if you need to adjust schedules or run `run-all` manually.

---

## Summary table


| Task                                     | After install | After update                             | After restart (gateway)                             | Scheduled (cron)                       | In run-all                        |
| ---------------------------------------- | ------------- | ---------------------------------------- | --------------------------------------------------- | -------------------------------------- | --------------------------------- |
| **Prune** (expired facts)                | No            | No                                       | Yes (startup + every 60 min)                        | Yes (nightly job step 1)               | Yes                               |
| **WAL recovery**                         | No            | No                                       | Yes (once at startup)                               | No                                     | No                                |
| **Startup prune**                        | No            | No                                       | Yes (once at startup)                               | No                                     | No                                |
| **Tier compaction** (hot/warm/cold)      | No            | No                                       | On session end (if enabled)                         | Yes (weekly-deep-maintenance)          | Yes                               |
| **Auto-classify** ("other" → categories) | No            | No                                       | Yes (5 min delay, then every 24 h if enabled)       | No                                     | No                                |
| **Proposals prune** (expired)            | No            | No                                       | Yes (every 24 h if personaProposals enabled)        | No                                     | No                                |
| **Language keywords build**              | No            | No                                       | Yes (3s if no file, then every N days if autoBuild) | Yes (monthly-consolidation step 2)     | Yes                               |
| **Session distill** (facts from logs)    | No            | No                                       | No                                                  | Yes (nightly-memory-sweep step 2)      | Yes (3 days, if distill enabled)  |
| **Extract-daily**                        | No            | No                                       | No                                                  | Yes (nightly-memory-sweep step 3)      | Yes (7 days, if enabled)          |
| **Extract-directives**                   | No            | No                                       | No                                                  | Yes (weekly-extract-procedures step 2) | Yes (7 days, if enabled)          |
| **Extract-reinforcement**                | No            | No                                       | No                                                  | Yes (weekly-extract-procedures step 3) | Yes (7 days, if enabled)          |
| **Extract-procedures**                   | No            | Yes (post-upgrade)                       | Yes (post-upgrade if version changed)               | Yes (weekly-extract-procedures step 1) | Yes (7 days, if enabled)          |
| **Generate-auto-skills**                 | No            | Yes (post-upgrade)                       | Yes (post-upgrade if version changed)               | Yes (weekly-extract-procedures step 4) | Yes (if enabled)                  |
| **Reflect** (patterns)                   | No            | Yes (post-upgrade if reflection.enabled) | Yes (post-upgrade if version changed)               | Yes (weekly-reflection step 1)         | Yes                               |
| **Reflect-rules**                        | No            | Yes (post-upgrade if reflection.enabled) | Yes (post-upgrade if version changed)               | Yes (weekly-reflection step 2)         | Yes                               |
| **Reflect-meta**                         | No            | Yes (post-upgrade if reflection.enabled) | Yes (post-upgrade if version changed)               | Yes (weekly-reflection step 3)         | Yes                               |
| **Generate-proposals**                   | No            | No                                       | No                                                  | Yes (weekly-persona-proposals)         | Yes (if personaProposals enabled) |
| **Self-correction-run**                  | No            | Yes (post-upgrade)                       | Yes (post-upgrade if version changed)               | Yes (self-correction-analysis)         | Yes                               |
| **Consolidate**                          | No            | No                                       | No                                                  | Yes (monthly-consolidation step 1)     | No                                |
| **Backfill-decay**                       | No            | No                                       | No                                                  | Yes (monthly-consolidation step 3)     | Yes (once, marker file)           |
| **Scope promote**                        | No            | No                                       | No                                                  | Yes (weekly-deep-maintenance step 2)   | No                                |


---

## By context

### After installation (`openclaw hybrid-mem install`)

- **Writes** `~/.openclaw/openclaw.json` with full defaults (memory slot, plugin config, compaction prompts, bootstrap limits, etc.).
- **Creates** `~/.openclaw/memory` and **ensures maintenance cron job definitions** in `~/.openclaw/cron/jobs.json`: any of the 7 canonical jobs that are missing are added (existing jobs are left as-is; disabled jobs are **not** re-enabled). The jobs are **not executed** by install; the scheduler (OpenClaw or system cron) runs them later.
- **Does not run** any maintenance tasks (no prune, distill, reflect, etc.). User should restart the gateway and optionally run `verify [--fix]` and/or `run-all` manually.

### After update (`openclaw hybrid-mem upgrade` + gateway restart)

- **Upgrade command:** Reinstalls the plugin (e.g. via `npx openclaw-hybrid-memory-install`). It does **not** run any maintenance.
- **After restart:** On first gateway start with a **new plugin version**, the **post-upgrade pipeline** runs once (after 20s delay):  
`build-languages` (if no lang file) → `self-correction-run` → `reflect` + `reflect-rules` (if reflection.enabled) → `extract-procedures` → `generate-auto-skills` → writes `.last-post-upgrade-version`.
- So **after update + restart**, the tasks that run are: normal **startup** behavior (prune, WAL recovery, timers) **plus** the post-upgrade sequence above.

### After restart (gateway start / plugin load)


| What                      | When                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Startup prune**         | Once, synchronously (remove expired facts).                                                                                |
| **WAL recovery**          | Once, synchronously (replay uncommitted store/update from previous run).                                                   |
| **Periodic prune**        | Every **60 minutes** (expired + soft decay).                                                                               |
| **Auto-classify**         | If `autoClassify.enabled`: once after **5 min**, then every **24 h**.                                                      |
| **Proposals prune**       | If `personaProposals.enabled`: every **24 h**.                                                                             |
| **Language keywords**     | If `languageKeywords.autoBuild`: once after **3 s** if no `.language-keywords.json`, then every `weeklyIntervalDays` days. |
| **Post-upgrade pipeline** | Once after **20 s** if plugin version changed (see “After update” above).                                                  |
| **Tier compaction**       | Not at startup; runs **on agent session end** if `memoryTiering.enabled` and `memoryTiering.compactionOnSessionEnd`.       |


### Scheduled (cron jobs)

The plugin **ensures** these job definitions exist in `~/.openclaw/cron/jobs.json` on **install**, **upgrade**, and **verify --fix**: missing jobs are added, existing ones can be normalized (schedule/pluginJobId). **Disabled jobs are never re-enabled** so user choices are honored. The jobs run only when your OpenClaw job runner or system cron runs them.


| Job name                      | Schedule           | Steps (what the job message tells the agent to run)                                    |
| ----------------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| **nightly-memory-sweep**      | Daily 02:00        | 1. prune 2. distill --days 3 3. extract-daily                                          |
| **self-correction-analysis**  | Daily 02:30        | self-correction-run                                                                    |
| **weekly-reflection**         | Sun 03:00          | reflect → reflect-rules → reflect-meta                                                 |
| **weekly-extract-procedures** | Sun 04:00          | extract-procedures → extract-directives → extract-reinforcement → generate-auto-skills |
| **weekly-deep-maintenance**   | Sat 04:00          | compact → scope promote                                                                |
| **weekly-persona-proposals**  | Sun 10:00          | generate-proposals (and notify if pending)                                             |
| **monthly-consolidation**     | 1st of month 05:00 | consolidate → build-languages → backfill-decay                                         |


### In `run-all` (`openclaw hybrid-mem run-all`)

Order of steps (feature flags may omit some):

1. **backfill-decay** (once per install, marker `.backfill-decay-done`)
2. **prune**
3. **compact**
4. **distill** (3 days) — if distill enabled
5. **extract-daily** (7 days) — if enabled
6. **extract-directives** (7 days) — if enabled
7. **extract-reinforcement** (7 days) — if enabled
8. **extract-procedures** (7 days) — if enabled
9. **generate-auto-skills** — if enabled
10. **reflect**
11. **reflect-rules**
12. **reflect-meta**
13. **generate-proposals** — if personaProposals enabled
14. **self-correction-run**
15. **build-languages**

**Not in run-all:** consolidate, scope promote, WAL recovery, startup prune, periodic prune, auto-classify, proposals prune. Use cron jobs or one-off CLI for those.

---

## Possible adjustments

- **Consolidate / backfill-decay / scope promote** only run from **scheduled** jobs (monthly or weekly-deep-maintenance), not from **run-all** or post-upgrade. If you want them after update or in a single manual pass, add them to the post-upgrade pipeline or run `run-all` plus `consolidate`, `backfill-decay`, `scope promote` manually.
- **run-all** does not include **consolidate** or **scope promote**; the scheduled **monthly-consolidation** and **weekly-deep-maintenance** jobs cover those.
- **After install:** no maintenance runs automatically. Consider recommending `openclaw hybrid-mem verify [--fix]` and optionally `run-all` (or at least backfill, prune, compact) after first install.
- **Post-upgrade** does not run: prune, compact, distill, extract-daily, extract-directives, extract-reinforcement, consolidate, backfill-decay, scope promote, generate-proposals. So a full “catch-up” after upgrade may still require a scheduled run or manual `run-all` plus the monthly/weekly steps you care about.

