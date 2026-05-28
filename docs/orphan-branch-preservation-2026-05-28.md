# Orphan Branch Preservation Report (2026-05-28)

## Purpose
Consolidate open orphan/orphan2 preservation pull requests into a single decision surface and preserve unresolved work with explicit rationale before closing legacy PRs.

## Summary
- Total open orphan/orphan2 PRs reviewed: 29
- Applied to consolidation branch: 3
- Report-only preservation (not applied): 25
- Already contained in main: 1
- Consolidation branch: `orphan/consolidated-preservation-20260528`

## Per-PR Preservation Log

### PR #1652: fix: upsert expired fact filtering (from orphaned pr-1634)

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1652
- Source branch/head: `orphan/pr-1634-upsert-fix` @ `28fe2486c9cd`
- Unique summary: `4` unique commit(s) vs main, `5` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit b83a2faf6ddd5b56398a71da9a4e2f85032271fd; see cherry-pick-pr-1652.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/src/worker/narratives.ts
- Top commit headlines:
- `b83a2faf6ddd` Add issue-1633 marker comment
- `da59f9badd5b` docs: use issue-linked TODO notation
- `1502aac89e63` fix: keep completed tasks out of active projection
- `28fe2486c9cd` Fix upsert ignoring expired fact filtering
- Top changed files:
- `extensions/memory-hybrid/cli/active-tasks.ts`
- `extensions/memory-hybrid/services/task-ledger-facts.ts`
- `extensions/memory-hybrid/services/task-ledger/canonical.ts`
- `extensions/memory-hybrid/src/worker/narratives.ts`
- `extensions/memory-hybrid/tests/task-ledger-facts.test.ts`

### PR #1653: fix: credential capture + CI hygiene (from orphaned fix-1591-ci)

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1653
- Source branch/head: `orphan/fix-1591-ci-preserve` @ `9db67724c187`
- Unique summary: `7` unique commit(s) vs main, `0` changed file(s) vs main
- Preservation status: **already contained in main**
- Rationale: No effective diff vs origin/main
- Risks/manual follow-up: none identified for code import; this PR had no remaining effective diff against current main.
- Top commit headlines:
- `b5ba2817ef5b` chore(issue-1578): start implementation branch
- `5d0751513db6` fix(security): block credential-like fallback to ordinary memory
- `c8441555806d` ci: refresh status [skip ci footer]
- `b2c280f627c1` fix: block credential capture without vault
- `5768cc4d658c` Remove accidentally committed CI refresh comment from README
- Top changed files:
- _No file diff listed_

### PR #1655: fix

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1655
- Source branch/head: `orphan/pr-1571-preserve` @ `853b439ec273`
- Unique summary: `13` unique commit(s) vs main, `4` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit 0a7407e4aaf90b601b8398099e4d833e7fa9e3c0; see cherry-pick-pr-1655.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (add/add): Merge conflict in docs/1557.md
- Top commit headlines:
- `0a7407e4aaf9` docs: scaffold issue #1557 stewardship PR
- `cbe907678d6b` fix: canonicalize active task fact labels
- `9492d38156b9` Fix provenance overwrite and display label collision bugs
- `9006b11f3d9c` Fix terminal status superseding title fact in syncActiveTaskEntryToFacts
- `1160cd37fbed` Fix canonicalLabel fallback to normalize separators
- Top changed files:
- `docs/1557.md`
- `extensions/memory-hybrid/cli/active-tasks.ts`
- `extensions/memory-hybrid/services/task-ledger-facts.ts`
- `extensions/memory-hybrid/tests/task-ledger-facts.test.ts`

### PR #1656: fix

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1656
- Source branch/head: `orphan/pr-1592-preserve` @ `801ad90e794b`
- Unique summary: `16` unique commit(s) vs main, `10` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit 642b6fd82fac093aef896467de39612ca40ec92d; see cherry-pick-pr-1656.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- The previous cherry-pick is now empty, possibly due to conflict resolution.
- If you wish to commit it anyway, use:
- 
-     git commit --allow-empty
- Top commit headlines:
- `642b6fd82fac` chore(issue-1579): start implementation branch
- `14692acfa625` feat(security): harden recalled memory blocks against prompt injectio…
- `2b2ac42ab9f5` refactor: extract RECALLED_CONTEXT_BOUNDARY to shared constant in ski…
- `140148667eb5` chore: sync memory-hybrid package lock
- `52442cbe6a81` fix: sanitize prompt injection in degraded recall path
- Top changed files:
- `extensions/memory-hybrid/lifecycle/stage-injection.ts`
- `extensions/memory-hybrid/lifecycle/stage-recall/run-recall.ts`
- `extensions/memory-hybrid/package-lock.json`
- `extensions/memory-hybrid/services/context-engine.ts`
- `extensions/memory-hybrid/services/retrieval-orchestrator.ts`
- `extensions/memory-hybrid/services/skill-prompt-injection.ts`
- `extensions/memory-hybrid/src/worker/narratives.ts`
- `extensions/memory-hybrid/tests/context-engine.test.ts`
- _... plus 2 additional file(s)_

### PR #1657: fix

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1657
- Source branch/head: `orphan/pr-1595-preserve` @ `f6108336ee02`
- Unique summary: `12` unique commit(s) vs main, `11` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit e131d8a002533665748c52134bad0851fbf64ee0; see cherry-pick-pr-1657.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/backends/facts-db/fact-read-queries.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/backends/facts-db/facts-db-layer1.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/backends/facts-db/maintenance.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/lifecycle/stage-injection.ts
- Top commit headlines:
- `e131d8a00253` fix(#1559): hot/progressive recall self-reinforces garbage memories
- `c8bf4437d470` Fix hot recall garbage loop bugs
- `0d7223695c5e` Fix prefix garbage checks to include summary field
- `8a1d1515e54d` Fix: Align demoteHotGarbageFacts SQL with isLikelyGarbage detector
- `c85fb0c50ede` fix hot recall review follow-up
- Top changed files:
- `extensions/memory-hybrid/backends/facts-db/crud.ts`
- `extensions/memory-hybrid/backends/facts-db/fact-read-queries.ts`
- `extensions/memory-hybrid/backends/facts-db/facts-db-layer1.ts`
- `extensions/memory-hybrid/backends/facts-db/index.ts`
- `extensions/memory-hybrid/backends/facts-db/maintenance.ts`
- `extensions/memory-hybrid/backends/facts-db/row-mapper.ts`
- `extensions/memory-hybrid/backends/migrations/facts-migrations.ts`
- `extensions/memory-hybrid/lifecycle/stage-injection.ts`
- _... plus 3 additional file(s)_

### PR #1658: fix

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1658
- Source branch/head: `orphan/pr-1596-preserve` @ `69b835abcfdc`
- Unique summary: `25` unique commit(s) vs main, `26` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit e71d45cf3dc847a6224dd101b3079d98b6acdcd4; see cherry-pick-pr-1658.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/backends/facts-db/crud.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/cli/commands/manage/register-storage-maintenance.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/services/capture-utils.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/tests/capture-utils.test.ts
- Top commit headlines:
- `e71d45cf3dc8` fix: add universal NOOP/classification pre-store guard (issue #1561)
- `fa0c36874f6a` fix: address five critical bugs in artifact rejection and code quality
- `3eb7c0f0b4ed` Fix three bugs in noop guard implementation
- `71bd6873333a` fix: guard rejected stores in memory_store tool and fix artifact clea…
- `0a4d8469073a` fix: address remaining noop guard review issues
- Top changed files:
- `extensions/memory-hybrid/backends/facts-db/crud.ts`
- `extensions/memory-hybrid/backends/facts-db/facts-db-layer1.ts`
- `extensions/memory-hybrid/cli/cmd-backfill.ts`
- `extensions/memory-hybrid/cli/cmd-distill.ts`
- `extensions/memory-hybrid/cli/cmd-extract-daily.ts`
- `extensions/memory-hybrid/cli/cmd-extract-directives.ts`
- `extensions/memory-hybrid/cli/cmd-extract-reinforcement.ts`
- `extensions/memory-hybrid/cli/cmd-feedback.ts`
- _... plus 18 additional file(s)_

### PR #1659: fix

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1659
- Source branch/head: `orphan/pr-1597-preserve` @ `bdc01671c3ad`
- Unique summary: `16` unique commit(s) vs main, `11` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit 27284a6582d465996159f711a701df60748ced54; see cherry-pick-pr-1659.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/backends/vector-db/vector-db-class.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/config/parsers/core.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/config/types/core.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/config/types/index.ts
- CONFLICT (add/add): Merge conflict in extensions/memory-hybrid/services/memory-pressure-snapshot.ts
- Top commit headlines:
- `27284a6582d4` feat(services): memory pressure snapshot diagnostic — Issue #1551
- `bbc4768a79c9` Fix memory pressure snapshot bugs
- `d06dcf5ac916` Fix 7 memory-pressure-snapshot bugs (Issue #1551)
- `6f410b945a4e` fix: memory-pressure-snapshot bugs
- `3c0d9bafea78` fix: address snapshot review feedback
- Top changed files:
- `extensions/memory-hybrid/backends/vector-db/vector-db-class.ts`
- `extensions/memory-hybrid/config/parsers/core.ts`
- `extensions/memory-hybrid/config/parsers/index.ts`
- `extensions/memory-hybrid/config/types/core.ts`
- `extensions/memory-hybrid/config/types/index.ts`
- `extensions/memory-hybrid/openclaw.plugin.json`
- `extensions/memory-hybrid/services/memory-pressure-snapshot.ts`
- `extensions/memory-hybrid/tests/helpers/comprehensive-e2e-harness.ts`
- _... plus 3 additional file(s)_

### PR #1660: fix

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1660
- Source branch/head: `orphan/pr-1600-preserve` @ `b893f6f92dc2`
- Unique summary: `6` unique commit(s) vs main, `5` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit f888b543ea97539b81a4abb14bd8128c59a450a3; see cherry-pick-pr-1660.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/backends/wal.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/services/error-reporter.ts
- Top commit headlines:
- `f888b543ea97` fix: persist pending error reports and surface WAL init failures
- `0e7f48fa2cc8` fix: prevent queue backlog loss on read failures
- `7d94324f74bf` fix: prevent queue read failure from disabling entire error reporter
- `156d56e86479` fix: wrap ensureQueueLoaded in try/catch to prevent network delivery …
- `bdddf253f15a` fix: normalize non-Error thrown values in wal.ts and guard persistPen…
- Top changed files:
- `extensions/memory-hybrid/backends/wal.ts`
- `extensions/memory-hybrid/services/error-reporter.ts`
- `extensions/memory-hybrid/setup/plugin-service.ts`
- `extensions/memory-hybrid/tests/error-reporter-persistence.test.ts`
- `extensions/memory-hybrid/tests/wal.test.ts`

### PR #1661: fix

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1661
- Source branch/head: `orphan/pr-1563-preserve` @ `23d60319a603`
- Unique summary: `6` unique commit(s) vs main, `5` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit 022580905eac0375bd07b1ef10c22fdc989c5b52; see cherry-pick-pr-1661.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/lifecycle/stage-active-task.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/services/active-task.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/services/context-audit.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/tests/active-task.test.ts
- Top commit headlines:
- `022580905eac` fix(active-task): skip stale rows in injection
- `c2c0a2533720` fix(active-task): report rendered injection count
- `2da4e25df119` Merge main into pr-1563
- `4e6665afff67` fix(active-task): restore correct excludeStale parameter semantics
- `a309b6290b23` Remove unused preCap variable and return value
- Top changed files:
- `extensions/memory-hybrid/lifecycle/stage-active-task.ts`
- `extensions/memory-hybrid/services/active-task-injection.ts`
- `extensions/memory-hybrid/services/active-task.ts`
- `extensions/memory-hybrid/tests/active-task-injection.test.ts`
- `extensions/memory-hybrid/tests/active-task.test.ts`

### PR #1662: fix

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1662
- Source branch/head: `orphan/pr-1589-preserve` @ `239a166bba1d`
- Unique summary: `7` unique commit(s) vs main, `2` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit d1db52070b4c4109f7d0466019f24c03aef48d17; see cherry-pick-pr-1662.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- The previous cherry-pick is now empty, possibly due to conflict resolution.
- If you wish to commit it anyway, use:
- 
-     git commit --allow-empty
- Top commit headlines:
- `d1db52070b4c` chore(issue-1575): start implementation branch
- `5bedc49fbbd0` fix: add early input validation to memory_store before WAL/embedding …
- `d9889f9ef9ab` fix(memory-store): validate text and importance before writing WAL
- `9bf5098ef1ad` style(biome): fix formatting in register-store-tools.ts
- `79dc7783aaec` Fix whitespace validation bypass after truncation in memory_store
- Top changed files:
- `extensions/memory-hybrid/tests/memory-store-early-validation.test.ts`
- `extensions/memory-hybrid/tools/memory/register-store-tools.ts`

### PR #1663: fix

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1663
- Source branch/head: `orphan/pr-1598-preserve` @ `9a9b2c9b4f9f`
- Unique summary: `11` unique commit(s) vs main, `7` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit fa49254c646a15fab0b2c31b4566c94ff237c710; see cherry-pick-pr-1663.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/cli/active-tasks.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/services/task-hygiene.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/services/task-ledger-facts.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/tests/task-hygiene.test.ts
- Top commit headlines:
- `fa49254c646a` fix: hygiene must verify live review threads before classifying PR-ba…
- `59b1aa4a5e55` fix: resolve PR hygiene bugs in task ledger and hygiene services
- `96b84f174763` Fix PR hygiene bugs: gh --json syntax, blockerStatus classification, …
- `d8b075159b14` Fix PR hygiene blocker status bugs
- `f4e0028212f5` Fix PR hygiene bugs: error fallback, opt-in config, and multi-task PR…
- Top changed files:
- `.github/scripts/forge-feedback-loop.mjs`
- `extensions/memory-hybrid/cli/active-tasks.ts`
- `extensions/memory-hybrid/cli/types.ts`
- `extensions/memory-hybrid/services/task-hygiene.ts`
- `extensions/memory-hybrid/services/task-ledger-facts.ts`
- `extensions/memory-hybrid/tests/forge-feedback-loop.test.ts`
- `extensions/memory-hybrid/tests/task-hygiene.test.ts`

### PR #1664: docs

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1664
- Source branch/head: `orphan/pr-1599-preserve` @ `dea4e761ec63`
- Unique summary: `4` unique commit(s) vs main, `3` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit 4d10103b6592b08fbe5656be97483a105d1dd050; see cherry-pick-pr-1664.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (add/add): Merge conflict in docs/OPERATOR-ARCHITECTURE-MAP.md
- Top commit headlines:
- `4d10103b6592` docs: add minimal operator architecture map (#1580)
- `526cb2fb17ab` ci: retrigger conventional commits check
- `f06c64e8d37a` docs: remove unsupported --json from verify runbook step
- `dea4e761ec63` Merge remote-tracking branch 'origin/main' into pr-1599
- Top changed files:
- `README.md`
- `docs/OPERATOR-ARCHITECTURE-MAP.md`
- `docs/index.md`

### PR #1665: fix

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1665
- Source branch/head: `orphan/pr-1603-preserve` @ `a9003f511b66`
- Unique summary: `6` unique commit(s) vs main, `12` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit 35af08437b60c907cfe2898828a05f4ec769258f; see cherry-pick-pr-1665.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/README.md
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/backends/vector-db/vector-db-class.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/cli/cmd-health.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/cli/commands/manage/register-storage-entities-decay.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/cli/commands/manage/register-storage-maintenance.ts
- CONFLICT (add/add): Merge conflict in extensions/memory-hybrid/services/vector-backend-observability.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/tests/user-friendly-cli.test.ts
- Top commit headlines:
- `35af08437b60` fix: resolve merge conflicts in cmd-health.ts and user-friendly-cli.t…
- `af787f3661dd` chore: apply biome formatting for PR #1603
- `35b17e6a5182` Remove unused VectorDB methods getStoreCount() and getInitGeneration()
- `23f90840b0ff` fix: address 4 review threads - backfill message, measurePathBytes pe…
- `168273743881` test: improve constants bounds test coverage - fix misleading name, a…
- Top changed files:
- `extensions/memory-hybrid/README.md`
- `extensions/memory-hybrid/backends/vector-db/constants.ts`
- `extensions/memory-hybrid/backends/vector-db/vector-db-class.ts`
- `extensions/memory-hybrid/cli/cmd-health.ts`
- `extensions/memory-hybrid/cli/commands/manage/register-storage-entities-decay.ts`
- `extensions/memory-hybrid/cli/commands/manage/register-storage-maintenance.ts`
- `extensions/memory-hybrid/cli/commands/manage/storage-stats-helpers.ts`
- `extensions/memory-hybrid/services/vector-backend-observability.ts`
- _... plus 4 additional file(s)_

### PR #1666: style

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1666
- Source branch/head: `orphan/feat/1605-embeddings-preserve` @ `fa66437ecadb`
- Unique summary: `8` unique commit(s) vs main, `10` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit f73e39c8abb31cc83b294c29a990ba245ed68e5f; see cherry-pick-pr-1666.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/config/parsers/retrieval.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/lifecycle/stage-recall/run-recall.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/services/context-audit.ts
- Top commit headlines:
- `f73e39c8abb3` fix: cap fixed recall blocks and add context budget audit
- `32fd4cd7a361` Fix fixed-block budget calculation bugs
- `61c89a554a54` Fix context-audit budget calculation bugs
- `45f40ab65f26` Fix bugs in recall stage: XML tag matching and degraded path budget caps
- `fd9b232a1887` style: apply biome formatting to run-recall.ts
- Top changed files:
- `docs/CONFIGURATION.md`
- `extensions/memory-hybrid/cli/commands/manage/register-storage-entities-decay.ts`
- `extensions/memory-hybrid/config/parsers/retrieval.ts`
- `extensions/memory-hybrid/config/types/retrieval.ts`
- `extensions/memory-hybrid/lifecycle/stage-recall/run-recall.ts`
- `extensions/memory-hybrid/openclaw.plugin.json`
- `extensions/memory-hybrid/services/context-audit.ts`
- `extensions/memory-hybrid/tests/config.test.ts`
- _... plus 2 additional file(s)_

### PR #1667: fix

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1667
- Source branch/head: `orphan/pr/1597-preserve` @ `816965d4b826`
- Unique summary: `6` unique commit(s) vs main, `7` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit 4a223d973e7bbce3492bd2f106b38a0094c96c9c; see cherry-pick-pr-1667.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/backends/vector-db/vector-db-class.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/config/parsers/core.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/config/types/core.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/config/types/index.ts
- CONFLICT (add/add): Merge conflict in extensions/memory-hybrid/services/memory-pressure-snapshot.ts
- Top commit headlines:
- `4a223d973e7b` feat(services): memory pressure snapshot diagnostic — Issue #1551
- `a50fa9c8d387` Fix memory pressure snapshot bugs
- `fc0d02fadf84` Fix 7 memory-pressure-snapshot bugs (Issue #1551)
- `40326036d51b` fix: memory-pressure-snapshot bugs
- `01b36d3fa17b` fix: format and type errors in memory-pressure-snapshot and config/pa…
- Top changed files:
- `extensions/memory-hybrid/backends/vector-db/vector-db-class.ts`
- `extensions/memory-hybrid/config/parsers/core.ts`
- `extensions/memory-hybrid/config/parsers/index.ts`
- `extensions/memory-hybrid/config/types/core.ts`
- `extensions/memory-hybrid/config/types/index.ts`
- `extensions/memory-hybrid/openclaw.plugin.json`
- `extensions/memory-hybrid/services/memory-pressure-snapshot.ts`

### PR #1668: chore: remove accidentally committed CI refresh comment from README (from orphaned pr1591)

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1668
- Source branch/head: `orphan/pr1591-final` @ `4817e6e835bc`
- Unique summary: `6` unique commit(s) vs main, `11` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit 177778452f52678e16ce53877c86ffee08e2f837; see cherry-pick-pr-1668.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- The previous cherry-pick is now empty, possibly due to conflict resolution.
- If you wish to commit it anyway, use:
- 
-     git commit --allow-empty
- Top commit headlines:
- `177778452f52` chore(issue-1578): start implementation branch
- `1ab2b92aab0b` fix(security): block credential-like fallback to ordinary memory
- `6f0d5a2586c4` ci: refresh status [skip ci footer]
- `5f21f291033f` fix: block credential capture without vault (resolved conflict)
- `495d06757924` Remove accidentally committed CI refresh comment from README
- Top changed files:
- `docs/CREDENTIALS.md`
- `docs/SESSION-DISTILLATION.md`
- `extensions/memory-hybrid/cli/cmd-distill.ts`
- `extensions/memory-hybrid/cli/cmd-extract-daily.ts`
- `extensions/memory-hybrid/cli/cmd-store.ts`
- `extensions/memory-hybrid/cli/commands/manage/register-corrections.ts`
- `extensions/memory-hybrid/cli/types.ts`
- `extensions/memory-hybrid/lifecycle/stage-capture/run-capture.ts`
- _... plus 3 additional file(s)_

### PR #1669: fix: capabilityHints type and default corrections (from orphaned pr1604)

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1669
- Source branch/head: `orphan/pr1604-final` @ `1c5f126615b9`
- Unique summary: `9` unique commit(s) vs main, `12` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit f953f67746b1f730ab198f0b4ea6947031995f89; see cherry-pick-pr-1669.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in docs/CONFIGURATION.md
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/config/parsers/retrieval.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/config/types/retrieval.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/setup/register-hooks.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/tests/config.test.ts
- CONFLICT (add/add): Merge conflict in extensions/memory-hybrid/tests/register-hooks-capability-hints.test.ts
- Top commit headlines:
- `f953f67746b1` fix: make capability hints session-only by default
- `810aec819d8c` fix: default capability hints off
- `fdc6314937a8` fix: resolve node 24 type errors (resolved conflict)
- `705446add5f9` Fix: Register capabilityHintsSessionsSeen with session cleanup
- `8c29cb4eae67` Fix: Add missing capabilityHints property to autoRecall schema
- Top changed files:
- `docs/CONFIGURATION.md`
- `extensions/memory-hybrid/config/parsers/retrieval.ts`
- `extensions/memory-hybrid/config/types/retrieval.ts`
- `extensions/memory-hybrid/lifecycle/hooks.ts`
- `extensions/memory-hybrid/lifecycle/session-state.ts`
- `extensions/memory-hybrid/lifecycle/types.ts`
- `extensions/memory-hybrid/openclaw.plugin.json`
- `extensions/memory-hybrid/setup/register-hooks.ts`
- _... plus 4 additional file(s)_

### PR #1670: style: stage recall budget helpers biome formatting (from orphaned pr-1605)

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1670
- Source branch/head: `orphan/pr1605-final` @ `da70bfb12d42`
- Unique summary: `23` unique commit(s) vs main, `11` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit 414070d17db1a28e3abbf91a4bfebd607d430d5a; see cherry-pick-pr-1670.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/config/parsers/retrieval.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/lifecycle/stage-recall/run-recall.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/services/context-audit.ts
- Top commit headlines:
- `414070d17db1` fix: cap fixed recall blocks and add context budget audit
- `b810e4bd8904` Fix fixed-block budget calculation bugs
- `87e8d9e82f0e` Fix context-audit budget calculation bugs
- `e5c651acb502` Fix bugs in recall stage: XML tag matching and degraded path budget caps
- `96766d1488b6` style: apply biome formatting to run-recall.ts
- Top changed files:
- `docs/CONFIGURATION.md`
- `extensions/memory-hybrid/cli/commands/manage/register-storage-entities-decay.ts`
- `extensions/memory-hybrid/config/parsers/retrieval.ts`
- `extensions/memory-hybrid/config/types/retrieval.ts`
- `extensions/memory-hybrid/lifecycle/stage-recall/run-recall.ts`
- `extensions/memory-hybrid/openclaw.plugin.json`
- `extensions/memory-hybrid/services/context-audit.ts`
- `extensions/memory-hybrid/tests/config.test.ts`
- _... plus 3 additional file(s)_

### PR #1671: test: skipped update side-effects regression coverage (from orphaned pr-1607)

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1671
- Source branch/head: `orphan/pr1607-final` @ `29fc40773e3d`
- Unique summary: `9` unique commit(s) vs main, `3` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit 71b3e0968a890ece755bb5249f6fbf64f69c0d77; see cherry-pick-pr-1671.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/backends/facts-db/fact-read-queries.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/services/task-ledger-facts.ts
- Top commit headlines:
- `71b3e0968a89` perf: use targeted project-fact query for active-task projection (#1553)
- `1d91e1642af4` format: fix biome formatting in fact-read-queries.ts
- `50d9e3791a83` perf: use single-row project fact lookup for projection status
- `3d8c1551d4e3` Merge origin/main into feat/1553--active-task-projection-perf
- `965c52da689e` Merge main into feat/1553--active-task-projection-perf
- Top changed files:
- `extensions/memory-hybrid/backends/facts-db/fact-read-queries.ts`
- `extensions/memory-hybrid/backends/facts-db/facts-db-layer2.ts`
- `extensions/memory-hybrid/services/task-ledger-facts.ts`

### PR #1672: fix+test: pre-store guard regressions (from orphaned pr-1610)

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1672
- Source branch/head: `orphan/pr1610-final` @ `0e2564265c95`
- Unique summary: `19` unique commit(s) vs main, `8` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit 9eeceb7d80b9199af1eb9d5a0b5984843352df2d; see cherry-pick-pr-1672.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/backends/facts-db/crud.ts
- Top commit headlines:
- `9eeceb7d80b9` fix: add universal pre-store guard to filter NOOP/classification/arti…
- `dc7778950745` fix: add universal pre-store guard + skip post-store ops on blocked e…
- `fe61e4fdd4e8` Fix pre-store guard bugs: prevent audit corruption and fake entry pro…
- `bfe6ffe23f1e` Fix WAL infinite retry and missing evicted vector cleanup
- `3f1afb71cf45` fix: guard credential log message and optimize blocked-set allocation
- Top changed files:
- `extensions/memory-hybrid/backends/facts-db/crud.ts`
- `extensions/memory-hybrid/backends/facts-db/facts-db-layer1.ts`
- `extensions/memory-hybrid/lifecycle/stage-capture/run-capture.ts`
- `extensions/memory-hybrid/routes/graphql-resolvers.ts`
- `extensions/memory-hybrid/tests/facts-db.test.ts`
- `extensions/memory-hybrid/tests/pr1332-remediation.test.ts`
- `extensions/memory-hybrid/tests/stage-capture.test.ts`
- `extensions/memory-hybrid/tools/memory/register-store-tools.ts`

### PR #1673: fix: strict closure guard for duplicate/superseded decisions (from closed pr-1611)

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1673
- Source branch/head: `orphan2/fix-strict-duplicate-closure-guard-1611` @ `cd43150bfe07`
- Unique summary: `3` unique commit(s) vs main, `3` changed file(s) vs main
- Preservation status: **applied**
- Rationale: Applied 3 commit(s) cleanly via cherry-pick
- Applied commits in consolidation: `3`
- Risks/manual follow-up: validate integrated behavior in normal CI; no additional manual porting required for this PR.
- Top commit headlines:
- `23e3a38a4830` feat(duplicates): add strict closure guard proof model
- `3ae2c07d01f5` fix: prevent empty candidates from yielding safe decision
- `cd43150bfe07` fix: align proof model types with service output and remove redundant…
- Top changed files:
- `extensions/memory-hybrid/services/duplicate-closure-guard.ts`
- `extensions/memory-hybrid/tests/duplicate-closure-guard.test.ts`
- `extensions/memory-hybrid/types/issue-types.ts`

### PR #1674: perf: SQL-level category filter for project-fact queries (from closed pr-1594)

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1674
- Source branch/head: `orphan2/feat-1553-task-ledger-sql-filter` @ `3e54e43b4f23`
- Unique summary: `1` unique commit(s) vs main, `3` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit 3e54e43b4f2341014f686ffcfda30da8fab5d0a8; see cherry-pick-pr-1674.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/backends/facts-db/facts-db-layer2.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/services/task-ledger-facts.ts
- Top commit headlines:
- `3e54e43b4f23` perf: SQL-level category filter for project-fact queries (#1553)
- Top changed files:
- `extensions/memory-hybrid/backends/facts-db/fact-read-queries.ts`
- `extensions/memory-hybrid/backends/facts-db/facts-db-layer2.ts`
- `extensions/memory-hybrid/services/task-ledger-facts.ts`

### PR #1675: fix: enforce generated skill byte limit (from closed pr-1543)

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1675
- Source branch/head: `orphan2/fix-1537-skill-byte-limit-guard` @ `44679d73b598`
- Unique summary: `6` unique commit(s) vs main, `5` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit 7fd47645667c52fdead1805d7b917145afd1cf14; see cherry-pick-pr-1675.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (add/add): Merge conflict in extensions/memory-hybrid/config/skill-size-limits.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/services/procedure-skill-generator.ts
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/services/skill-validator.ts
- Top commit headlines:
- `7fd47645667c` fix: enforce generated skill byte limit
- `734973c38c40` test: handle optional generator decisions
- `d2a50a24e5d7` style: format generated skill byte-limit changes
- `86857adce598` Remove unused exported constants from skill-size-limits.ts
- `49bc42dae35a` Fix skill validator byte check to include HTML comments
- Top changed files:
- `extensions/memory-hybrid/config/skill-size-limits.ts`
- `extensions/memory-hybrid/services/procedure-skill-generator.ts`
- `extensions/memory-hybrid/services/skill-validator.ts`
- `extensions/memory-hybrid/tests/crystallization.test.ts`
- `extensions/memory-hybrid/tests/procedure-skill-generator.test.ts`

### PR #1676: feat: active-task ledger live-state reconciliation placeholder (from closed pr-1627)

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1676
- Source branch/head: `orphan2/feat-1625-active-task-refresh-live-state` @ `0926706e0173`
- Unique summary: `2` unique commit(s) vs main, `1` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit 5c7f9434d65c20afc983b2f232851bc38dd5d14c; see cherry-pick-pr-1676.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/services/task-ledger/canonical.ts
- Top commit headlines:
- `5c7f9434d65c` fix(1624): add deterministic tie-break in groupProjectFactsByEntity
- `0926706e0173` feat(1625): active-task ledger live-state reconciliation — placeholder
- Top changed files:
- `extensions/memory-hybrid/services/task-ledger/canonical.ts`

### PR #1677: fix: deterministic tie-break in groupProjectFactsByEntity (from closed pr-1626)

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1677
- Source branch/head: `orphan2/fix-1624-active-task-renderer-stale-status` @ `8d277228605f`
- Unique summary: `2` unique commit(s) vs main, `1` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit 5c7f9434d65c20afc983b2f232851bc38dd5d14c; see cherry-pick-pr-1677.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in extensions/memory-hybrid/services/task-ledger/canonical.ts
- Top commit headlines:
- `5c7f9434d65c` fix(1624): add deterministic tie-break in groupProjectFactsByEntity
- `8d277228605f` Fix missing text fallback in terminal status check
- Top changed files:
- `extensions/memory-hybrid/services/task-ledger/canonical.ts`

### PR #1678: docs: fix issue 1551 outline hierarchy (from closed pr-1567)

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1678
- Source branch/head: `orphan2/issue-1551-enhance-diagnostics-capture-native-rss-fd-evidence-on-memory-pressure` @ `5614e4886ccc`
- Unique summary: `2` unique commit(s) vs main, `1` changed file(s) vs main
- Preservation status: **applied**
- Rationale: Applied 2 commit(s) cleanly via cherry-pick
- Applied commits in consolidation: `2`
- Risks/manual follow-up: validate integrated behavior in normal CI; no additional manual porting required for this PR.
- Top commit headlines:
- `155933993c98` docs: scaffold issue #1551 stewardship PR
- `5614e4886ccc` docs: fix issue 1551 outline hierarchy and SQLite naming
- Top changed files:
- `docs/1551.md`

### PR #1679: chore: CI workflow updates for conventional commits (from closed pr-1572)

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1679
- Source branch/head: `orphan2/issue-1559-fix-hot-progressive-recall-self-reinforces-garbage-memories-via-recall` @ `0674e3ef3de9`
- Unique summary: `3` unique commit(s) vs main, `2` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit 3ad0e12d1d0d33316a94d68d04133632b4e6932a; see cherry-pick-pr-1679.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in .github/workflows/pr-checks.yml
- Top commit headlines:
- `7d601920d4b1` docs(issue-1559): scaffold stewardship PR and clarify issue metadata …
- `3ad0e12d1d0d` ci(pr-checks): allow draft PR titles in conventional-commits check
- `0674e3ef3de9` ci: allow semantic PR check to write statuses
- Top changed files:
- `.github/workflows/pr-checks.yml`
- `docs/1559.md`

### PR #1680: perf: avoid full fact loads for projection injection (from closed pr-1569)

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1680
- Source branch/head: `orphan2/issue-1553-perf-avoid-loading-all-facts-for-active-task-projection-injection` @ `3db67f8a3a52`
- Unique summary: `1` unique commit(s) vs main, `1` changed file(s) vs main
- Preservation status: **applied**
- Rationale: Applied 1 commit(s) cleanly via cherry-pick
- Applied commits in consolidation: `1`
- Risks/manual follow-up: validate integrated behavior in normal CI; no additional manual porting required for this PR.
- Top commit headlines:
- `3db67f8a3a52` perf(active-task): avoid full fact loads for projection injection
- Top changed files:
- `docs/1553.md`

### PR #1681: chore: CI conventional commits workflow updates (from closed pr-1568)

- Original PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1681
- Source branch/head: `orphan2/issue-1552-fix-stale-and-duplicate-active-task-rows-are-still-injected-into-promp` @ `25d117c1ea7f`
- Unique summary: `3` unique commit(s) vs main, `2` changed file(s) vs main
- Preservation status: **report-only (preserved in this report)**
- Rationale: Cherry-pick conflict at commit 25d117c1ea7f37280c557c2932638ccb72bcdeb4; see cherry-pick-pr-1681.log
- Risks/manual follow-up: manual/Copilot owner should port intent from this PR if still desired; conflicts prevented safe blind replay.
- Conflict evidence from replay attempt:
- CONFLICT (content): Merge conflict in .github/workflows/pr-checks.yml
- Top commit headlines:
- `7a99ce1eef31` docs: scaffold issue #1552 stewardship PR
- `5bba20c024bb` docs: fix heading hierarchy and remove stale metadata in 1552.md
- `25d117c1ea7f` ci: add WIP type and wip option to conventional-commits check
- Top changed files:
- `.github/workflows/pr-checks.yml`
- `docs/1552.md`

