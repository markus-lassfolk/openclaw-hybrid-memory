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

## Rationale

| Rule | Why |
|------|-----|
| Require CI to pass | Prevents broken code from landing on `main` |
| Require 1 review | External PRs get a human sanity check |
| No force pushes | Preserves commit history and prevents accidents |
| Auto-delete branches | Keeps the repository tidy |
