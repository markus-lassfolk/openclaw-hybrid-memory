# PR #133 merge analysis: Revert memory-to-skills feature

**PR:** [Revert memory-to-skills feature (revert of #116)](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/133)  
**Branch:** `revert-116-feature/memory-to-skills-114`  
**Goal:** Merge the revert into `main` so the memory-to-skills feature (issue #114, merged in #116) is removed.

---

## 1. Conflict summary

The revert was created when the repo was earlier than current `main`. Merging it into `main` produces **8 conflicted areas** (some files have multiple conflict blocks).

| File | Conflict type | What to do |
|------|----------------|------------|
| `docs/CONFIGURATION.md` | Content | **Take revert:** Remove the whole "Memory-to-skills (issue #114)" section (config table + cron note). Keep the "LLM model tiers" section that follows. |
| `docs/MEMORY-TO-SKILLS.md` | Modify/delete | **Take revert:** Delete the file (revert branch deletes it). |
| `extensions/memory-hybrid/backends/facts-db.ts` | Content | **Take revert:** Remove the method `listProceduresUpdatedInLastNDays` (only used by memory-to-skills). |
| `extensions/memory-hybrid/cli/distill.ts` | Content | **Take revert:** Remove the `skills-suggest` command block (the entire `.command("skills-suggest")` … `.action(...)`). |
| `extensions/memory-hybrid/cli/handlers.ts` | Content (7 blocks) | **Take revert** in each block: remove memory-to-skills cron options, overrides, and `runSkillsSuggestForCli`. See §2. |
| `extensions/memory-hybrid/config.ts` | Content (2 blocks) | **Take revert:** Remove `MemoryToSkillsConfig` type and the `memoryToSkills` parsing block. |
| `extensions/memory-hybrid/services/memory-to-skills.ts` | Modify/delete | **Take revert:** Delete the file (revert branch deletes it). |
| `extensions/memory-hybrid/utils/text.ts` | Content | **Take revert:** Remove the `slugifyForSkill` function (only used by memory-to-skills). |

---

## 2. handlers.ts – what to remove (take revert in every conflict)

Resolve every conflict in `cli/handlers.ts` by **keeping the revert (theirs) side**, i.e. remove:

1. **ensureMaintenanceCronJobs (comment + signature + body)**  
   - From the comment: remove the two lines about `scheduleOverrides` and `messageOverrides`.  
   - From the signature: remove `scheduleOverrides` and `messageOverrides` from the options type and destructuring.  
   - From the body: remove the logic that applies `scheduleExpr` from `scheduleOverrides` and `messageOverrides?.[id]` (and the `messageOverrides` normalization in the `else` branch).

2. **runInstallForCli (cron setup)**  
   - Replace the block that uses `getPluginEntryConfig`, `memToSkills`, `schedule`, `notify`, and `ensureMaintenanceCronJobs(..., { scheduleOverrides, messageOverrides })` with the simpler revert version: get `pluginConfig` from config and call `ensureMaintenanceCronJobs(openclawDir, pluginConfig, { normalizeExisting: false, reEnableDisabled: false })`.

3. **runVerifyForCli (opts.fix – cron jobs)**  
   - Remove the `const scheduleOverrides = ...` block (lines 1232–1235).  
   - Call `ensureMaintenanceCronJobs(..., { normalizeExisting: true, reEnableDisabled: false })` with **no** `scheduleOverrides` or `messageOverrides`.

4. **runSkillsSuggestForCli**  
   - Remove the entire function `runSkillsSuggestForCli` (revert removes it). The next function should be `runExtractDirectivesForCli`.

5. **runUpgradeForCli (cron jobs)**  
   - Remove the `const scheduleOverrides = ...` block (lines 3041–3043).  
   - Call `ensureMaintenanceCronJobs(..., { normalizeExisting: true, reEnableDisabled: false })` with **no** `scheduleOverrides` or `messageOverrides`.

You must also remove or adjust:

- **MAINTENANCE_CRON_JOBS:** Remove the entry whose `pluginJobId` is `nightly-memory-to-skills` (and any reference to `buildMemoryToSkillsMessage` for it).
- **buildMemoryToSkillsMessage:** Remove this function (only used for that job).
- **References to `runSkillsSuggest` / `runSkillsSuggestForCli`** in `cli/register.ts` or `cli/manage.ts` (command registration for `skills-suggest`).
- **config-set / verify display:** Remove or guard any references to `cfg.memoryToSkills` (e.g. the log line that prints `memoryToSkills: …` and any config-set handling for `memoryToSkills.*`).

---

## 3. config.ts – what to remove

- **HybridMemoryConfig:** Remove the `memoryToSkills: MemoryToSkillsConfig` property (and ensure no other type extends or references it for memory-to-skills).
- **MemoryToSkillsConfig:** Delete the type (revert removes it).
- **Parse block:** Remove the block that builds `memoryToSkills` from `cfg.memoryToSkills` (the one that sets `enabled`, `schedule`, `windowDays`, etc.).
- **Return object:** Remove `memoryToSkills` from the parsed config object returned by the schema.

---

## 4. Other files to touch after resolving conflicts

- **openclaw.plugin.json:** Revert branch may remove a memory-to-skills-related entry; keep that removal.
- **setup/cli-context.ts:** Remove any `runSkillsSuggestForCli` or memory-to-skills-specific fields from the context type if present.
- **cli/register.ts** (or wherever `skills-suggest` is registered): Remove the registration of the `skills-suggest` command and any reference to `runSkillsSuggestForCli`.
- **index.ts:** Remove exports or imports of `runMemoryToSkills`, `runSkillsSuggestForCli`, or the memory-to-skills service.
- **Tests:** Remove or skip tests that target memory-to-skills (e.g. `memory-to-skills.test.ts` or memory-to-skills cases in config/handlers tests). Update any tests that assert on `memoryToSkills` config or the `skills-suggest` command.

---

## 5. Recommended way to merge

**Option A – Resolve on branch (recommended)**  
1. Check out `revert-116-feature/memory-to-skills-114`.  
2. Merge `origin/main` into it: `git merge origin/main`.  
3. Resolve every conflict by **keeping the revert’s intent**: remove memory-to-skills (docs, config, cron job, CLI command, service, and helpers). Use the table and sections above.  
4. Remove any remaining references to `memoryToSkills`, `runSkillsSuggestForCli`, `buildMemoryToSkillsMessage`, and the `nightly-memory-to-skills` job.  
5. Run tests and fix any failures (remove or adjust tests as in §4).  
6. Push the branch and merge PR #133.

**Option B – Resolve on main**  
1. Check out `main`.  
2. Merge `origin/revert-116-feature/memory-to-skills-114` into `main`.  
3. Resolve conflicts the same way (always favor the revert side for memory-to-skills).  
4. Clean up and test as in Option A, then push `main` and close PR #133 (or merge via UI if you prefer).

---

## 6. Checklist before merging

- [ ] All 8 conflict areas resolved (revert side kept for memory-to-skills removal).
- [ ] `docs/MEMORY-TO-SKILLS.md` deleted.
- [ ] `extensions/memory-hybrid/services/memory-to-skills.ts` deleted.
- [ ] No remaining references to `memoryToSkills`, `MemoryToSkillsConfig`, `runSkillsSuggestForCli`, `runMemoryToSkills`, or `buildMemoryToSkillsMessage`.
- [ ] `MAINTENANCE_CRON_JOBS` has no `nightly-memory-to-skills` entry.
- [ ] `skills-suggest` command removed from CLI (distill.ts / register / manage).
- [ ] `listProceduresUpdatedInLastNDays` removed from facts-db.
- [ ] `slugifyForSkill` removed from utils/text.ts.
- [ ] `npm test` passes (after updating/removing memory-to-skills tests).
- [ ] Optional: `openclaw hybrid-mem verify` and `openclaw hybrid-mem --help` run without errors and show no memory-to-skills commands or config.

---

## 7. Merged branches deleted

The following remote branches were deleted (their PRs were already merged into main):

- `alert-autofix-1` … `alert-autofix-6`
- `copilot/sub-pr-123`
- `feature/active-task-subagent-awareness-108`
- `feature/memory-diagnostics-and-directives`

PR #133 is the only open PR from the remaining branch: `revert-116-feature/memory-to-skills-114`.
