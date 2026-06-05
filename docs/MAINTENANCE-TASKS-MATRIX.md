# Maintenance tasks: when they run

This matrix shows **which maintenance tasks run** in each context (installation, update, restart, scheduled jobs, and `run-all`). The **hybrid orchestrator** (48 steps, staggered per-step guards) replaces the previous 18 separate cron jobs.

Use `openclaw hybrid-mem maintenance steps` to inspect guard intervals and eligibility.

---

## Architecture (hybrid)

| Layer | Trigger | What runs |
| ----- | ------- | --------- |
| **Gateway tick** | Every 60 min (+ startup delay) | `maintenance cycle` tier — local steps (prune, compact, sensor-sweep, …) |
| **Consolidated cron** | Daily 02:00 (`hybrid-mem:maintenance-nightly`) | `openclaw hybrid-mem maintenance nightly --verbose` — LLM-heavy steps with staggered guards |
| **Manual** | `run-all` / `maintenance full` | Cycle + nightly tiers (alias for orchestrator) |

**Guards control cadence**, not separate weekly/monthly cron jobs. Weekly/monthly-frequency steps use 5d/25d guards and are checked every nightly run.

---

## Summary table (selected tasks)

| Task | After install | After update + restart | Gateway tick (cycle) | Nightly orchestrator | In run-all |
| ---- | ------------- | ---------------------- | -------------------- | -------------------- | ---------- |
| **Prune** | No | Startup + cycle tick | Yes (1h guard) | No | Yes |
| **Compact** | No | Session end (if tiering) | Yes (20h guard) | No | Yes |
| **Auto-classify** | No | — | Yes (20h, if enabled) | No | Yes |
| **Sensor sweep** | No | — | Yes (3h, if enabled) | No | Yes |
| **Proposals prune** | No | — | Yes (20h) | No | Yes |
| **Build-languages** | No | Post-upgrade | Yes (5d guard) | Yes (5d guard) | Yes |
| **Distill** | No | — | No | Yes (20h guard) | Yes |
| **Extract-daily** | No | — | No | Yes (20h guard) | Yes |
| **Dream-cycle (core)** | No | — | No | Yes (68h guard) | Yes |
| **Reflect chain** | No | Post-upgrade | No | Yes (5d guards) | Yes |
| **Self-correction-run** | No | Post-upgrade | No | Yes (44h guard) | Yes |
| **Backfill-decay** | No | — | No | Yes (once, marker) | Yes (once) |

See `maintenance steps` for the full 48-step registry.

---

## By context

### After installation (`openclaw hybrid-mem install`)

- Writes `~/.openclaw/openclaw.json` and ensures **one consolidated cron job** (`hybrid-mem:maintenance-nightly`) in `~/.openclaw/cron/jobs.json`.
- On **upgrade/verify --fix** with consolidated mode (default), legacy hybrid-mem cron jobs are marked `superseded: true` and disabled.
- Does **not** run maintenance tasks. Restart the gateway and run `verify [--fix]` or `maintenance full --dry-run`.

Set `maintenance.orchestrator.consolidatedCronJobs: false` to keep legacy per-task cron jobs.

### After restart (gateway)

| What | When |
| ---- | ---- |
| Startup prune + WAL recovery | Once at startup |
| **Maintenance tick** | Every 60 min → orchestrator `cycle` tier |
| Post-upgrade pipeline | Once after 20s if plugin version changed |
| Watchdog | Separate 5 min timer (unchanged) |

Replaced timers (now in cycle tier): prune, auto-classify, language-keywords, passive-observer, proposals-prune.

### Scheduled (cron)

| Job | Schedule | Command |
| --- | -------- | ------- |
| **maintenance-nightly** | Daily 02:00 | `openclaw hybrid-mem maintenance nightly --verbose` |

The orchestrator runs due steps only (staggered guards: 20h / 44h / 68h / 5d / 25d). Typical night: ~5–7 LLM steps instead of all 14+.

### CLI commands

| Command | Description |
| ------- | ----------- |
| `maintenance cycle` | Local gateway-native steps |
| `maintenance nightly` | All non-cycle steps (guards decide which run) |
| `maintenance full` | Cycle + nightly |
| `maintenance steps` | List steps, guard intervals, last run, eligibility |
| `run-all` | Alias for `maintenance full` |

### Scan windows

Cursor-driven commands (`distill`, `extract-procedures`, `extract-directives`, `extract-reinforcement`, `extract-implicit`, `self-correction-run`) use **scan cursors** — the orchestrator does not pass `--days` except:

- `extract-daily`: `--days 7`
- `self-correction-run`: `--days 1`

### Override flags (`--force` / `--full`)

| Flag | Effect |
| ---- | ------ |
| `--force` | Bypass per-step guards and scan cooldowns/watermarks |
| `--full` | Legacy alias for `--force` on scan commands |

**Orchestrator / run-all:** `--force` bypasses per-step guard files (`~/.openclaw/memory/step--{name}.ms`).

Automated runs (cron, gateway tick) never use `--force` or `--dry-run`.

---

## Possible adjustments

- Run `maintenance steps` to see which steps are due and their stagger cadence.
- Use `maintenance full --force` for a manual catch-up after long downtime.
- Disable consolidated cron with `maintenance.orchestrator.consolidatedCronJobs: false` if you need the legacy 18-job layout.
