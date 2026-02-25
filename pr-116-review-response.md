## PR #116 — Review feedback addressed

All review feedback from Codex, Copilot, Cursor Bugbot, and the GPT/Gemini council has been addressed in this branch. Summary:

### Config & behaviour
- **memoryToSkills.enabled** — Now respects explicit `true`: if the user sets `memoryToSkills.enabled: true`, the pipeline runs even when `procedures.enabled` is false (Codex P2, config default vs hard dependency). Config comment updated.
- **listProceduresUpdatedInLastNDays** — `days` is clamped to [1, 365] and invalid/NaN/≤0 return `[]` (GPT Council 🟡).

### YAML & parsing
- **parseSynthesizedSkill** — Strips markdown code fences (```` ```markdown ... ``` ````) before parsing so frontmatter is found when the LLM wraps output (Gemini Council 🟠).
- **YAML frontmatter** — `name` is always the computed slug; `description` is written via `JSON.stringify` for safe escaping. No raw LLM text in frontmatter (Cursor Bugbot / GPT Council 🔴).

### Slug dedup & recipe
- **Slug collision** — Single loop: resolve a unique slug with `existingSlugs.has(slug) || existsSync(...)` so the second cluster gets `skill-1` instead of being skipped as “dedup” (Cursor Bugbot, Copilot).
- **recipe.json** — Uses majority tool sequence across the cluster (`majorityToolSequence`) instead of `procs[0]` (Cursor Bugbot, Copilot).

### Workspace & helpers
- **workspaceRoot** — Passed explicitly from the CLI into `runMemoryToSkills` via `SkillsSuggestOptions.workspaceRoot`; service no longer relies only on `process.cwd()` (GPT Council 🟠).
- **getPluginEntryConfig** — New helper used in install path for cron schedule override to avoid deep config walks (GPT Council 🟡).

### Other
- **slugify** — Shared `slugifyForSkill()` in `utils/text.ts`; memory-to-skills uses it (Copilot).
- **Prompt** — “procedure instance(s)” for singular/plural (Copilot).
- **Tests** — `parseSynthesizedSkill` code-fence stripping; `memoryToSkills.enabled: true` when procedures disabled; `listProceduresUpdatedInLastNDays(0)` / `(-1)` return `[]`.

Schedule (2:15 AM default, configurable via `memoryToSkills.schedule` and scheduleOverrides at install/verify/upgrade) and info/verbose logging were already correct in the branch; no further changes there.

All tests pass. Ready for merge.
