## Summary

<!-- What does this PR do? Why? -->

Closes #

**PR title:** Must follow [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `fix: …`, `chore: merge develop into main`). CI validates the title via the **Conventional Commits** check.

**Large merges:** For branches with many commits (e.g. `develop` → `main`), GitHub may pre-fill the merge/squash description with every commit message. Before completing merge or auto-merge, switch to **Squash and merge** (if allowed) and replace that body with a short summary, or merge locally with `git merge -m "…"`.

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Refactor / internal improvement (no behavior change)
- [ ] Documentation update
- [ ] CI / tooling change

## Quality Checklist

Run from repo root (package lives under `extensions/memory-hybrid/`):

- [ ] `cd extensions/memory-hybrid && npx tsc --noEmit` passes with no errors
- [ ] `cd extensions/memory-hybrid && npm run lint` passes with no warnings
- [ ] `cd extensions/memory-hybrid && npm test` passes (all tests green)
- [ ] No secrets, credentials, or API keys committed
- [ ] No `console.log` debug statements left in production code

## Documentation Impact (REQUIRED)

<!-- Have you checked if this change affects the broader architecture or other functions? -->

- [ ] Inline code comments (JSDoc) updated for modified functions and types
- [ ] `docs/` or `README.md` updated to reflect architectural or usage changes
- [ ] Cross-referenced functions/services checked for outdated documentation

## Testing

<!-- Describe how you tested this change. -->

- [ ] Unit tests added / updated
- [ ] Integration tests added / updated
- [ ] Manually verified against a running OpenClaw instance

## Notes for Reviewer

<!-- Anything specific to review, tricky parts, open questions, etc. -->
