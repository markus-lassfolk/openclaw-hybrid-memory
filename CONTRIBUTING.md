# Contributing to OpenClaw Hybrid Memory

Thanks for helping improve Hybrid Memory.

## Quick start for contributors

1. Fork and clone the repo.
2. Install dependencies:
   ```bash
   cd extensions/memory-hybrid
   npm ci
   ```
3. Validate locally before opening a PR:
   ```bash
   npm run lint
   npm run build
   npm run test
   ```

## What to work on first

- Look for issues labeled **good first issue** or **help wanted**.
- Product-impact lanes:
  - session observability / explainability
  - retrieval quality and precision
  - onboarding reliability
  - docs/demo clarity

## Pull request checklist

- Keep changes focused and small.
- Add/update tests for behavior changes.
- Update docs for user-facing changes.
- Use a Conventional Commit PR title (`feat:`, `fix:`, `docs:`, etc.).

## Security and privacy expectations

- Never commit secrets, API keys, or personal data.
- Keep local-first defaults intact.
- Use parameterized SQL and avoid unsafe dynamic query interpolation.

## Getting help

- Read `docs/` first (`QUICKSTART`, `CONFIGURATION`, `ARCHITECTURE`, `CLI-REFERENCE`).
- Open a discussion/issue with repro steps and expected vs actual behavior.
