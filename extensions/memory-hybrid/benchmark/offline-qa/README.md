# Offline QA (real Maeve data, local dev machine)

Run maintenance tasks against a **copy** of live Maeve data without touching production.
Everything lands in gitignored `.offline-qa/` (and mirrors sessions into `.ab-fixtures/` for A/B runs).

## What gets copied (and what does not)

| Copied | Skipped (private / dangerous) |
|--------|----------------------------------|
| Session JSONL (`main`, `scholar`, `hybrid-cron`) | Credentials vault |
| `facts.db` (full or sample) | API keys (redacted config only) |
| Optional Lance vectors | `~/.ssh`, tokens, env files |
| Facts sample JSON (for consolidation A/B) | Full `openclaw.json` secrets |
| Redacted plugin + LLM tier config | |
| Recent cron maintenance logs (optional) | |

## Quick start

```bash
cd extensions/memory-hybrid

# 1. Fetch from Maeve (SSH must work: markus@192.168.1.224)
bash benchmark/offline-qa/fetch-maeve-offline-qa.sh

# 2. Build sandbox HOME layout
bash benchmark/offline-qa/setup-sandbox.sh

# 3. Run QA (dry-run by default — no DB writes)
MINIMAX_API_KEY=... AZURE_OPENAI_API_KEY=... npm run offline-qa
```

## Fetch options

```bash
# Smaller facts DB (~5k recent facts) instead of full ~471MB
OFFLINE_QA_FACTS=sample bash benchmark/offline-qa/fetch-maeve-offline-qa.sh

# Include Lance vectors (can be large)
OFFLINE_QA_LANCE=1 bash benchmark/offline-qa/fetch-maeve-offline-qa.sh

# More / fewer sessions
OFFLINE_QA_SESSION_DAYS=90 OFFLINE_QA_SESSION_CAP=600 bash benchmark/offline-qa/fetch-maeve-offline-qa.sh

# Skip cron log copy
OFFLINE_QA_CRON_LOGS=0 bash benchmark/offline-qa/fetch-maeve-offline-qa.sh
```

## QA runner options

```bash
npm run offline-qa -- --skip-ab     # skip A/B matrix (saves LLM cost)
npm run offline-qa -- --live        # run maintenance against work copy (writes)
npm run offline-qa -- --setup       # rebuild sandbox template from raw
npm run offline-qa -- --reuse-work  # reuse sandbox-work without re-cloning
npm run offline-qa -- -v            # verbose task output
```

## What the runner does

1. **Preflight** — manifest, session count, API key checks
2. **Corpus scan** — SC/reinforcement incident counts from real sessions (no LLM)
3. **A/B matrix** — full model×thinking sweep via `npm run ab-maintenance` (unless `--skip-ab`)
4. **Maintenance tasks** — distill, extract-reinforcement, self-correction, reflection on a **cloned work HOME** (`out/<timestamp>/home/` or `sandbox-work` with `--reuse-work`)
5. **openclaw run-all --dry-run** — if `openclaw` CLI is in PATH, runs against the work copy `HOME`

Reports: `.offline-qa/out/<timestamp>/qa-report.md` + `task-results.json`

## Directory layout

```
.offline-qa/
  manifest.json
  raw/                  # fetched from Maeve (immutable source)
  sandbox/              # pristine template — never run live tests here
  sandbox-work/         # default mutable copy (npm run offline-qa:clone)
  out/<timestamp>/
    home/               # per-run clone (npm run offline-qa clones fresh each time)
    qa-report.md
    task-results.json
```

## Sandbox template vs work copy

| Path | Purpose |
|------|---------|
| `sandbox/` | **Template** built from `raw/` — read-only baseline |
| `sandbox-work/` | **Default work copy** for manual CLI testing |
| `out/<run>/home/` | **Per-run clone** created automatically by `npm run offline-qa` |

```bash
# Create / reset mutable copy for manual testing
npm run offline-qa:clone    # sandbox → sandbox-work
npm run offline-qa:reset    # same (fresh clone from template)

export HOME="$(pwd)/.offline-qa/sandbox-work"
openclaw hybrid-mem run-all -v

# After code fixes, reset and re-run
npm run offline-qa:reset
```

`npm run offline-qa` clones `sandbox/` → `out/<timestamp>/home/` automatically so each orchestrated run starts clean without touching the template.

Flags:
- `--reuse-work` — skip clone; reuse existing `sandbox-work/` (faster iteration)
- `--work-home PATH` — clone template to a custom path for this run

## Quick start

## Using openclaw CLI directly

After `npm run offline-qa:clone`:

```bash
export HOME="$(pwd)/.offline-qa/sandbox-work"
export MINIMAX_API_KEY=...          # maintenance LLM (MiniMax-only)
export AZURE_OPENAI_API_KEY=...     # embeddings via Azure Foundry (Maeve APIM gateway)
# optional override if gateway URL differs from fetched Maeve config:
# export AZURE_FOUNDRY_BASE_URL=https://rnd-api-gateway.azure-api.net/ai
openclaw hybrid-mem run-all --dry-run -v
openclaw hybrid-mem reflect --dry-run
openclaw hybrid-mem distill --days 3 --dry-run
```

Reset between runs: `npm run offline-qa:reset`

Tier config for maintenance models: `benchmark/ab-maintenance/maeve-tier-snippet.json`

## Re-fetch before major releases

Re-run fetch when Maeve has new sessions or after tier/config changes on production.
Compare new `qa-report.md` to previous runs under `.offline-qa/out/`.
