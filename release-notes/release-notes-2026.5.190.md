# Release notes — OpenClaw Hybrid Memory **2026.5.190**

**Release date:** 2026-05-19  
**Since:** [2026.5.101](release-notes-2026.5.101.md) (2026-05-10)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **`[2026.5.190]`**

This is a large feature and reliability release: generated-skill pipelines, procedure promotion, crystallization hardening, a broad “similarity sweep” of parse/await/atomic-write fixes, and a major internal module split for maintainability.

---

## Who should upgrade

| You run… | Why upgrade |
|----------|-------------|
| **Generated / promoted skills** | Safer writes, validation gates, queue UX, TTL archival, and clearer promotion scoring. |
| **Dream cycle, goals, active tasks** | Stronger stewardship, idempotent implicit feedback, and fewer CLI hangs. |
| **Hybrid memory in production** | JSON parse guards, atomic file writes, vector-db init timeouts, and `SQLITE_BUSY` retries. |
| **Multi-agent or Telegram sessions** | Pre-finalization and session-ref matching fixes reduce false blocks. |
| **Operators / SRE** | Doctor flow, session observability CLI, verify JSON on stderr, cost playbook. |

---

## Highlights (plain language)

### Generated skills got a full lifecycle

Skills promoted from procedures now go through **content gates**, **static validation**, and optional **eval harnesses**. Promotion can use **outcome-aware evidence** instead of raw counts alone. Writes to disk are **atomic** (temp dir + rename, completion markers) so a crash mid-write does not leave half a skill tree.

**Skills CLI** gained queue UX: reject, approve with description, and clearer telemetry when promotion is ambiguous. Idle skills can be **archived** using `skillTTLDays`.

### Procedures and promotion are smarter and safer

- **Risk-aware scoring** and nested promotion gates (context signals, eval hooks).
- **Evidence-hash milestones** and skills rescan for quarantined / stale entries.
- **Enum normalization** for legacy `procedure_type` / `skill_state` rows.
- **`staticValidation`** now means only the static/recipe gate—not every defer reason.

### Reliability sweep (the “boring” fixes that prevent outages)

A coordinated pass hardened places where bad JSON, missing `await`, or non-atomic writes could crash or corrupt state:

- **Home Assistant sensor sweep** — guarded JSON parse; invalid entities skipped instead of failing the whole sweep.
- **Backfill / distill / language-keywords / procedures** — malformed JSONL or config no longer takes down entire runs.
- **Config / features commands** — `runConfigView` is properly awaited.
- **Stage capture, self-correction, install** — multi-file and workspace copies use atomic writes.
- **Vector DB** — init-failure guards, semantic-cache tolerance, count and ONNX load timeouts.
- **Ollama bootstrap** — deduped auto-start, spawn errors handled, `unref()` so the parent process can exit.

### Operator experience

- **`hybrid-mem verify --json`** — human diagnostics go to **stderr**; stdout stays machine-parseable.
- **Corrections config registration** — no longer leaks log lines into JSON stdout.
- **Dashboard** — Lance size cache check closes a TOCTOU race.
- **Doctor, observability CLI, quick-start** — easier onboarding and debugging (see #1317, #1320).

### Architecture (mostly invisible, helps future PRs)

Large files were split into focused modules under `cli/commands/manage/`, `backends/facts-db/procedures/`, `routes/dashboard/`, and lifecycle helpers. Similar-sweep PR workflow is documented in `docs/SIMILAR-SWEEP-PR.md`.

---

## What changed by area

### Skills & procedures

- Unified skill section taxonomy; validate/install parity ([#1440](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1440)).
- Lifecycle recovery, disk reconciler, service extraction ([#1447](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1447)).
- Procedure scoring, promotion gates, skills queue CLI ([#1450](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1450), [#1454](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1454), [#1455](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1455)).
- Archive idle skills + `skillTTLDays` ([#1453](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1453)).
- Procedural pipeline MVP ([#1460](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1460)).
- Skill safety: PEM, paths, loopback, email allow-list ([#1445](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1445), [#1461](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1461)).

### Memory, retrieval & vectors

- Transactional fact lifecycle, bulk vector delete, LanceDB UUID predicates ([#1324](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1324)).
- Retrieval breadcrumbs logged without breaking semantic embed ([#1507](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1507)).
- Alias index init race guard ([#1522](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1522)).
- `SQLITE_BUSY` retry on fact store ([#1506](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1506)).

### Crystallization & workflows

- `schema_meta` migrations for crystallization & workflow stores ([#1459](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1459)).
- Atomic approval/install; supersede older pattern installs ([#1444](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1444), [#1456](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1456)).
- YAML multiline patch + H1 rename ([#1457](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1457)).

### Dream cycle, goals & stewardship

- CLI no longer hangs on service timers ([#1309](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1309)).
- Dream-cycle integrity and implicit-feedback idempotency ([#1313](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1313)).
- Cron orchestration visibility and analyzer watchdogs ([#1321](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1321)).
- Active tasks + goal stewardship hardening ([#1323](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1323)).

### Autopilot (foundation)

- Pending digest foundation, digest autopilot skeleton, triage adapters ([#1335](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1335)–[#1338](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1338), [#1346](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1346)).

---

## Upgrade notes

1. **Version alignment** — Install plugin and installer at the same version:

   ```bash
   npm install -g openclaw-hybrid-memory@2026.5.190
   ```

   If you use **`openclaw-hybrid-memory-install`**, use **2026.5.190** there too.

2. **Procedure success rates** — Re-scanning old session JSONL now uses **any-failure-wins** per session. Historical procedure success counts may **drop** if a session had an early tool failure before a later success. This is intentional for accuracy.

3. **`staticValidation` semantics** — Dashboards or scripts that treated any defer as `staticValidation: false` should key off the specific gate fields instead.

4. **Multi-agent deployments** — If pre-finalization felt “stuck,” retry after upgrade; `related_session` false positives were reduced ([#1504](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1504)).

5. **No schema version bump required** for the 2026.5.190 metadata release itself; crystallization/workflow migrations run via existing `schema_meta` paths when those features are enabled.

---

## Install

```bash
npm install -g openclaw-hybrid-memory@2026.5.190
```

From a checkout:

```bash
cd extensions/memory-hybrid && npm install && npm run build
```

---

## Statistics

- **~90+** commits on `main` since `v2026.5.101`
- **Date range:** 2026-05-10 → 2026-05-19

---

## Changelog

See **[CHANGELOG.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)** — section **`[2026.5.190]`**.
