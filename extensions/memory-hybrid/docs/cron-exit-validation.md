# Cron Exit Ledger Validation

## Overview

As of this fix, hybrid-memory cron jobs now validate that all required maintenance steps complete successfully before reporting `status: ok`. This prevents the dangerous situation where cron state shows "healthy" while maintenance is actually failing.

## Problem

Previously, cron jobs could report `status: ok` even when:
- Required maintenance steps failed (non-zero exit codes)
- Steps were missing from the exit ledger
- Commands were invalid (`unknown command` errors)
- Only partial work completed (e.g., only `prune` ran, not `distill`/`extract`/etc.)
- Guard files weren't updated due to failures

This happened because OpenClaw cron treated "agent produced a response" as success, regardless of what that response contained.

## Solution

### 1. Exit Ledger Validation (`services/cron-exit-validator.ts`)

New module that validates maintenance execution by:
- Parsing HM_EXIT file for all step results
- Checking for `unknown command` errors in HM_LOG
- Validating all required steps are present with `exit=0`
- Supporting skip variants (e.g., `distill-skipped` when config disabled)
- Returning structured status: `success`, `partial`, or `failed`

### 2. Updated Cron Message Templates (`services/cron-job-bash-harness.ts`)

Enhanced templates now include:
- Explicit validation instructions for agents
- List of required steps that must complete
- Clear success criteria (all steps present with `exit=0`)
- Mandatory guard update only after successful validation
- Structured reply format for debugging

### 3. Message Normalization (`cli/cmd-install.ts`)

When `normalizeExisting=true` (e.g., during `verify --fix`):
- Updates existing cron job messages to match current definitions
- Removes obsolete command references (e.g., `consolidate-episodes`)
- Preserves guard prefixes while updating orchestration instructions
- Ensures all jobs use latest validation rules

### 4. Validation CLI Command (`cli/commands/manage/register-validate-cron-exit.ts`)

New internal command for validating cron execution:
```bash
openclaw hybrid-mem validate-cron-exit \
  --exit-path ~/.openclaw/logs/cron-hybrid-mem/nightly-memory-sweep-*.exit.txt \
  --log-path ~/.openclaw/logs/cron-hybrid-mem/nightly-memory-sweep-*.log \
  --required-steps prune distill extract-daily resolve-contradictions enrich-entities \
  --allow-skip
```

Returns exit code 1 if validation fails.

## Expected Behavior

### Success

All required steps present with `exit=0`:
```
2024-05-08T02:00:00Z prune exit=0
2024-05-08T02:01:00Z distill exit=0
2024-05-08T02:02:00Z extract-daily exit=0
```
- `maintenanceStatus`: `success`
- `guardUpdated`: `true`
- Cron status: `ok`

### Failed

Any step missing or non-zero exit:
```
2024-05-08T02:00:00Z prune exit=0
2024-05-08T02:01:00Z distill exit=1
```
- `maintenanceStatus`: `failed`
- `guardUpdated`: `false`
- Cron status should be: `error` (agent must signal failure)

### All required steps missing (empty or incomplete ledger)

When the exit file exists but **none** of the required steps appear in the ledger (including an empty file), validation returns **`failed`**. That pattern matches an abort before the first `hm_step` wrote to `HM_EXIT`, and must not be treated as a successful skip.

Use config skip variants (e.g. `distill-skipped` with `--allow-skip`) when a step is intentionally omitted.

### Partial

Some steps missing:
```
2024-05-08T02:00:00Z prune exit=0
(distill and others missing)
```
- `maintenanceStatus`: `partial`
- `guardUpdated`: `false`
- Cron status should be: `error`

## Config-Based Skipping

When a feature is disabled in config, the cron message instructs the agent to replace that step with a skip variant:

```bash
# If distill.enabled is false:
hm_step "distill-skipped" bash -c 'echo distill disabled; exit 0'
```

With `allowSkip=true`, the validator accepts these skip variants as satisfying the required step.

## Migration Path

Existing installations with old cron job definitions will be updated automatically when:

1. User runs `openclaw hybrid-mem verify --fix`
2. Plugin upgrade triggers `ensureMaintenanceCronJobs(..., { normalizeExisting: true })`
3. Gateway restart (sync from persistent guard files)

The message normalization preserves the guard prefix while updating the orchestration body to include validation rules.

## Testing

Comprehensive tests in `tests/cron-exit-validator.test.ts`:
- Exit line parsing (valid, invalid, non-zero codes)
- Unknown command detection
- Success/failed/partial status determination (all-required-missing → failed)
- Skip variant handling
- Missing file handling

All 14 tests pass.

## Acceptance Criteria Met

✅ Required-step failure makes cron run non-OK
✅ Unknown command makes cron run non-OK
✅ Missing required steps treated as failure
✅ Empty or incomplete ledgers do not produce a false `ok` / skip outcome
✅ Message normalization removes obsolete commands
✅ Validation instructions embedded in all cron messages

## Future Work

To fully close the loop, OpenClaw cron core would need to:
1. Accept structured status from agent (not just text response)
2. Map `maintenanceStatus` → cron `status` (`success`→`ok`, `failed`/`partial`→`error`)
3. Update `lastRunStatus` and `consecutiveErrors` based on maintenance outcome

Until then, agents must signal failure explicitly (e.g., by mentioning "FAILED" in response or exiting with error) when validation fails.
