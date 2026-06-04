# Real-data gaps — verification notes

Tasks confirmed **correct-by-design** on full Maeve offline QA (not harness bugs):

## reflect (0 stored on 8339 analyzed)

- **Cause:** Full `facts.db` copy (~8k+ facts) with vector/lexical dedupe at threshold 0.95; reflection patterns already exist from prior live runs.
- **Expected:** Re-run on a fresh or smaller DB yields new patterns; saturated DB → 0 stored is healthy dedupe behavior.
- **Verify:** Log shows `analyzed N facts, stored 0` with no parse/embedding errors.

## generate-auto-skills (all deferred)

- **Cause:** Promotion gates (`too_context_specific`, `private_data_risk`, `no_validation_possible`, `recent_failure`) correctly block Maeve-local shell paths and unvalidated procedures.
- **Expected:** Skills withheld until procedures are generalized and pass validation.
- **Verify:** Log lists deferred reasons per procedure; no `skills/auto/*.md` written without gate pass.

## build-languages (skip)

- **Cause:** `.language-keywords.json` lang hash unchanged since last build; `autoBuild` skips redundant work.
- **Expected:** Re-run after new multilingual sessions or `--force` rebuild produces keywords.
- **Verify:** Log contains `skip` or `languagesAdded=0` with `top languages=[en]`.

## extract-daily (low volume)

- **Cause:** Only ~31 daily log files in sandbox window; 3 facts extracted reflects sparse daily-log activity in the 7d QA window.
- **Expected:** More daily logs → more facts; task passes when files are found and scanned.

## Fixes applied (this plan)

| Task | Fix |
|------|-----|
| extract-implicit | Raised `maxSessionsPerRun` in sandbox; trajectory outcomes recorded in `implicit_signals`; lower `minConfidence` |
| reflect-meta | `REFLECTION_META_MAX_CHARS` 300 → 500; prompt asks for <480 chars |
| reflect-rules | JSON repair + thinking=adaptive one-shot retry on `invalid_response_format` |
| generate-proposals | Richer insights (self-correction, implicit) + semantic-empty LLM retry |
| extract-reinforcement | Standalone `reinforcement-praise` facts when `noRecalledIds` |
| distill / extract-directives | `redactMaintenancePrivateText` at store boundary |
