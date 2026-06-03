/**
 * Default required-step lists for hybrid-mem maintenance cron jobs.
 * Used by verify --reconcile and `hybrid-mem reconcile-cron-ledgers`.
 *
 * Keys use installed `pluginJobId` values from cmd-install (e.g. nightly-distill, not the job display name).
 */
const NIGHTLY_DISTILL_STEPS = ["prune", "distill", "resolve-contradictions", "enrich-entities"];

export const HYBRID_MEM_CRON_DEFAULT_JOB_STEPS: Record<string, string[]> = {
  "hybrid-mem:nightly-distill": NIGHTLY_DISTILL_STEPS,
  /** Legacy ledger basename if present; same steps as nightly-distill. */
  "hybrid-mem:nightly-memory-sweep": NIGHTLY_DISTILL_STEPS,
  "hybrid-mem:nightly-dream-cycle": ["dream-cycle"],
  "hybrid-mem:weekly-reflection": ["reflect", "reflect-rules"],
  "hybrid-mem:nightly-self-correction": ["self-correct"],
  "hybrid-mem:self-correction-analysis": ["self-correction-run"],
  "hybrid-mem:sensor-sweep": ["sensor-sweep-tier-1", "sensor-sweep-tier-2"],
  "hybrid-mem:weekly-persona-proposals": ["generate-proposals"],
  "hybrid-mem:weekly-extract-procedures": [
    "extract-procedures",
    "extract-directives",
    "extract-reinforcement",
    "generate-auto-skills",
  ],
  "hybrid-mem:weekly-deep-maintenance": ["compact", "vectordb-optimize", "scope-promote"],
};
