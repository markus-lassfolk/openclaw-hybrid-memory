# Contributing to OpenClaw Hybrid Memory

Thanks for helping improve Hybrid Memory.

## Quick start for contributors

**Node.js:** This repo requires **Node.js ≥ 22.16.0** (see `.nvmrc`). The plugin uses `node:sqlite`, which is unavailable on Node 20. CI runs on Node 22.16 and Node 24.

If you use **Cursor on WSL**, the integrated agent may prepend Cursor’s bundled Node 20 to `PATH`. This repo mitigates that automatically:

- `npm test`, `npm run build`, and `npm run lint` in `extensions/memory-hybrid` re-exec via `/usr/bin/node` (or `nvm` / `OPENCLAW_NODE_PATH`) when needed.
- Open a terminal with the workspace profile **“bash (Node 22)”** (`.vscode/settings.json`), or run `export PATH="/usr/bin:$PATH"` before manual commands.

1. Fork and clone the repo.
2. Install dependencies:
   ```bash
   cd extensions/memory-hybrid
   npm ci
   ```
3. Validate locally before opening a PR — the required trio from the PR template checklist:
   ```bash
   npx tsc --noEmit
   npm run lint
   npm test
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
