/**
 * Default required-step lists for hybrid-mem maintenance cron jobs.
 * Used by verify --reconcile and `hybrid-mem reconcile-cron-ledgers`.
 *
 * Keys use installed `pluginJobId` values from cmd-install (e.g. nightly-distill, not the job display name).
 */
const NIGHTLY_DISTILL_STEPS = ["prune", "distill", "extract-daily", "resolve-contradictions", "enrich-entities"];

export const HYBRID_MEM_CRON_DEFAULT_JOB_STEPS: Record<string, string[]> = {
  "hybrid-mem:nightly-distill": NIGHTLY_DISTILL_STEPS,
  /** Legacy ledger basename if present; same steps as nightly-distill. */
  "hybrid-mem:nightly-memory-sweep": NIGHTLY_DISTILL_STEPS,
  "hybrid-mem:nightly-dream-cycle": ["dream-cycle"],
  "hybrid-mem:weekly-reflection": ["reflect", "reflect-rules"],
  "hybrid-mem:nightly-self-correction": ["self-correct"],
  "hybrid-mem:weekly-sensor-sweep": ["sensor-sweep"],
  "hybrid-mem:weekly-persona-proposals": ["generate-proposals"],
};
