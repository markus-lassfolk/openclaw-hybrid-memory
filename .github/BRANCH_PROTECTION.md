# Branch Protection Recommendations

Recommended settings for `main` branch protection on GitHub.

## Settings (Settings → Branches → Add rule for `main`)

### Require status checks to pass before merging
- Enable: **Require branches to be up to date before merging**
- Required status checks:
  - `Type Check (Node 22)`
  - `Type Check (Node 24)`
  - `Lint (Node 22)`
  - `Lint (Node 24)`
  - `Test (Node 22)`
  - `Test (Node 24)`

### Require a pull request before merging
- Enable for external contributors
- **Required approvals: 1**
- Dismiss stale pull request approvals when new commits are pushed

### Protect matching branches
- **Do not allow force pushes**
- **Do not allow deletions**

### Auto-delete head branches
Enable **Automatically delete head branches** (under repository settings) to keep the branch list clean after merges.

### Keep PR branches linear (avoid merge-commit ladders)
When updating an open PR with latest `main`, **rebase** instead of merging `main` into the feature branch. Merge commits like `Merge branch 'main' into issue-…` stack up in the Git graph and make history hard to read.

- GitHub UI: **Update branch** → choose **Rebase** when offered (repo setting: *Settings → General → Pull Requests → Allow rebase merging* and prefer rebase for branch updates).
- CLI: `gh pr update-branch <number> --rebase`
- Local: `git fetch origin main && git rebase origin/main` (see `docs/SIMILAR-SWEEP-PR.md`)

Prefer **Squash and merge** when landing PRs on `main` so `main` stays a single commit per change.

### Prune stale local branches
After PRs merge, remove local copies so the IDE graph stays readable:

```bash
./scripts/prune-local-branches.sh        # preview
./scripts/prune-local-branches.sh --apply
```

For stashes and leftover fix/review branches (archives first, then deletes):

```bash
./scripts/purge-git-safe.sh              # preview
./scripts/purge-git-safe.sh --apply
```

Recovery: `git branch my-work archive/<branch-name>` or apply patches under `wip/archive/stashes/`.

## Rationale

| Rule | Why |
|------|-----|
| Require CI to pass | Prevents broken code from landing on `main` |
| Require 1 review | External PRs get a human sanity check |
| No force pushes | Preserves commit history and prevents accidents |
| Auto-delete branches | Keeps the repository tidy |
