# OpenClaw model switch bug report: GPT-5.4 Pro / Responses API session switching

## Summary

We traced a real OpenClaw bug in the live `/model` session-switch path.

Symptoms:
- Switching a live session to `gpt5pro` / `azure-foundry-responses/gpt-5.4-pro` appeared to succeed or partially succeed.
- Subsequent prompts did **not** reliably run on the selected model.
- In some cases users saw the generic error:
  - `There was an issue with your request. Please check your inputs and try again`

This was **not primarily a config problem** and **not an Azure model naming problem**.
It was a bug in how OpenClaw applied model overrides to the live session entry.

## Root cause

The `/model` path wrote override metadata like:
- `sessionEntry.modelOverride`
- `sessionEntry.providerOverride`

But it did **not** update the runtime fields actually consumed downstream:
- `sessionEntry.model`
- `sessionEntry.modelProvider`

Worse, it eagerly deleted `sessionEntry.model` in the runtime-present path.

So the switch command could look successful while the live runtime still did not have the selected model/provider wired into the session entry that the runtime actually reads.

## Affected area

The relevant logic was traced to:
- `src/sessions/model-overrides.ts`

Specifically the function handling the live application of a selected model to the session entry (reported as `applyModelOverrideToSessionEntry`).

## Minimal fix

When applying a non-default model selection, update the live runtime fields too:

```ts
entry.model = selection.model;
entry.modelProvider = selection.provider;
```

And stop unconditionally deleting `entry.model` in the runtime-present path.

## Why this fixes it

Downstream runtime resolution was reading:
- `entry.model`
- `entry.modelProvider`

If only `modelOverride`/`providerOverride` were updated, the runtime switch was incomplete.
By setting the live runtime fields directly, the selected model becomes the actual active model for the session.

## Observed result after patch

After patching and rebuilding locally, switching with:

```text
/model azure-foundry-responses/gpt-5.4-pro
```

reported success and subsequent prompts reportedly ran on GPT-5.4 Pro as expected.

## Practical guidance for other OpenClaw instances

If another OpenClaw instance shows this behavior:
- `/model` appears to switch
- but the live session does not actually move to the selected model
- especially for Responses API models like `azure-foundry-responses/gpt-5.4-pro`

then inspect the local OpenClaw code for the session model override path and verify that:
1. the selected model is written to `entry.model`
2. the selected provider is written to `entry.modelProvider`
3. `entry.model` is not being deleted before runtime selection occurs

## Important distinction

This bug is separate from:
- bad config on a host
- missing credentials
- provider quota/auth failures
- Doris-specific runtime issues

Those can also exist, but this specific failure mode was an **OpenClaw bug in live session model switching**.

## Recommendation

Other agents/operators can use this report as a patch guide:
1. inspect local `model-overrides` implementation
2. apply the minimal fix above
3. rebuild/restart OpenClaw
4. verify with a live `/model ...` switch and a follow-up prompt

## Status

- Root cause identified
- Minimal fix identified
- Local patch reportedly validated
- Still recommended: add regression coverage for session switching across providers, especially Responses API models
