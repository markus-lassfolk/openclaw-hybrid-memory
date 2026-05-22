## Summary

NOOP/classification decision facts are stored in the database because the same raw text that triggers `shouldCapture()` also triggers the store path — and the NOOP skip only applies inside classification flows, not as a universal pre-store quality rule. This adds a hard pre-store guard rejecting classifier artifacts and LLM reasoning traces before any store path.

## Changes

### `services/capture-utils.ts`
- Added `isPromptArtifactOrReasoningTrace(text)` function covering:
  - Chain-of-thought markers: `think`, `<think>`, `<thinking>`, `think`+`Thinking Process`, `Thinking Process:`
  - Classifier preamble: "The user is asking me to classify..."
  - Classifier output lines: NOOP |, ADD |, UPDATE |, DELETE | (case-insensitive)
  - Classifier JSON: arrays/objects with action field
  - Capability hint blocks: `<!-- memory-hybrid: ... -->`
- Added `isMemoryArtifact()` alias
- Updated `shouldCapture()` to call the guard first

### `backends/facts-db/crud.ts`
- Added pre-store guard in `storeFact()` that returns a no-op result for artifact text
- This covers all store paths: auto-capture, CLI, passive observer, GraphQL, WAL replay, etc.

### `cli/commands/manage/register-storage-maintenance.ts`
- Added `memory-hybrid storage maintenance classification-artifacts` command
- Dry-run by default; use `--apply` to supersede artifact facts and delete LanceDB vectors
- Use `--json` for machine-readable output

### `tests/capture-utils.test.ts`
- Added 20 test cases for `isPromptArtifactOrReasoningTrace()`
- All 48 tests pass

## Acceptance Criteria
- [x] Add pre-store quality guard rejecting NOOP/| classifier output, classifier JSON, classifier prompt text, and capability-hint patterns before any store path
- [x] Regression test: store a fact with text `NOOP | some classification decision text`; it must not appear in recall or HOT  
- [x] Add maintenance migration to supersede existing artifact facts and remove LanceDB vectors
- [x] All tests pass
