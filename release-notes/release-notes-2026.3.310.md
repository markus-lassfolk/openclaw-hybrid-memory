# Release Notes — OpenClaw Hybrid Memory 2026.3.310

**Date:** 2026-03-31  
**Previous baseline:** 2026.3.300

## Summary

Version **2026.3.310** includes all updates shipped after **2026.3.300**. This release focuses on reliability and operator clarity:

- Better resilience when embedding providers/models differ in vector dimensions.
- Smoother runtime behavior under recall and retry-heavy scenarios.
- Safer startup with automatic migration of legacy LanceDB tables that are missing the `why` field.
- Clearer health-check guidance for OpenClaw gateway RPC probes.
- CI/workflow dependency refreshes for long-term maintenance.

## What changed since 2026.3.300

### 1) Recall responsiveness and event-loop fairness

- **Auto-recall now yields to the event loop** during processing ([#931](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/931)).
- Practical impact: less risk of short stalls during heavy recall work; better responsiveness in long-running sessions.

### 2) Embeddings hardening and dimension mismatch resilience

- Multiple embedding paths were hardened to avoid brittle failures when dimensions/providers/config differ ([#932](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/932), [#934](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/934), [#941](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/941)).
- Coverage includes:
  - verify CLI behavior and model/deployment alignment,
  - embedding factory/shared resolution,
  - bootstrap and migration paths,
  - vector DB safety checks and diagnostics.
- Practical impact: fewer “mismatch surprise” failures after provider/model/config changes and clearer operational behavior when fallbacks trigger.

**Operator notes**

- **`openclaw hybrid-mem verify`** now treats **embedding width ↔ LanceDB** misalignment as a **failed** check (non-zero exit), and performs a **live embedding request** to confirm runtime dimensions (expect one embedding API call per verify run for that probe).
- Installs that were previously “green” but semantically broken may start **failing verify** until config and Lance vectors are aligned — that is intentional so monitors and scripts can detect the condition. Fix config, then run **`openclaw hybrid-mem re-index`** when the vector table was built under the wrong model.
- **Follow-up work** from post-merge review is tracked as separate issues (no blockers for this release): [#942](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/942) (CLI throttle knob for re-index), [#943](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/943) (shared rate-limit module), [#944](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/944) (validate dimensions before VectorDB), [#945](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/945) (grep-friendly quota logs), [#946](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/946) (lastSearchFailReason concurrency docs).

### 3) Chat/narrative transient failure classification

- Retry and narrative handling was refined so timeout/abort-family failures are treated as expected transient conditions where appropriate ([#935](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/935), [#936](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/936)).
- Practical impact: less noisy hard-failure/error-reporting behavior for transient network/runtime conditions.

### 4) Store-embed reporting noise reduction

- Store-embed now suppresses expected embedding/circuit-breaker error classes before escalating to plugin error reporting ([#937](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/937)).
- Practical impact: cleaner error signals and better issue triage.

### 5) Legacy LanceDB schema migration safety

- Added migration logic for legacy tables missing the `why` column in LanceDB.
- Practical impact: smoother upgrades from older installations; fewer manual repair steps.

### 6) Documentation and operations guidance

- Added explicit docs for RPC health probe timeout behavior and warm-up false positives, including recommended `--timeout 45000` (or 30s+) usage in scripts and dashboards ([#938](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/938)).
- **[CLI reference](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/CLI-REFERENCE.md):** `verify` documents the embedding probe, alignment failure exit code, and links to troubleshooting.
- **[Troubleshooting](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/TROUBLESHOOTING.md):** New sections on **embedding vs LanceDB dimension mismatch** and **Azure/APIM rate limits during re-index** (with pointers to [#939](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/939)–[#941](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/941), [#940](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/940), and follow-up [#942](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/942)).
- **Source comments:** `parseRetryAfterMs` / quota-403 classification reference issue [#940](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/940); `VectorDB` documents `lastSearchFailReason` concurrency semantics (see [#946](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/946)).

### 7) CI/dependency maintenance updates

- Updated GitHub Actions versions (`cache`, `stale`, `github-script`, `setup-node`, `labeler`) and refreshed dev lock state.
- Practical impact: healthier CI baseline and reduced drift in workflow tooling.

### 8) Type-safety and chat parsing cleanup

- Fixed a TypeScript cast issue (`TS2352`) around `Headers` handling in retry-after parsing.
- Refactored duplicated case-insensitive header lookup logic in chat retry code.

## Full commit list since 2026.3.300

1. `6af76081` — fix(recall): yield event loop during auto-recall (#931)  
2. `43f42af7` — fix(embeddings,chat,narratives): issues #932/#934–#937, release 2026.3.301  
3. `d70bf95e` — chore(deps-dev): bump the minor-and-patch group (#929)  
4. `a3ce5f00` — chore(deps): bump actions/stale from 9 to 10 (#925)  
5. `6618a7b7` — chore(deps): bump actions/github-script from 7 to 8 (#926)  
6. `24944129` — chore(deps): bump actions/setup-node from 4 to 6 (#927)  
7. `5c248fe9` — chore(deps): bump actions/labeler from 5 to 6 (#928)  
8. `f4f57e53` — chore(deps): bump actions/cache from 4 to 5 (#924)  
9. `dcc0ef4a` — fix(vector): migrate legacy LanceDB tables missing why column  
10. `39c70e3d` — docs: RPC health probe timeout and warm-up (#938)  
11. `56674ec1` — fix(embeddings): resolve dimension mismatch and improve embedding ops resilience (#941)  
12. `dc5c822e` — fix(memory-hybrid): resolve TS2352 Headers cast in parseRetryAfterMs  
13. `00f6fe80` — refactor(chat): dedupe case-insensitive header lookup helper

## Install

```bash
npm install -g openclaw-hybrid-memory@2026.3.310
```

## Publish

```bash
cd extensions/memory-hybrid
npm run verify:publish
npm publish --otp=$OTP
```
