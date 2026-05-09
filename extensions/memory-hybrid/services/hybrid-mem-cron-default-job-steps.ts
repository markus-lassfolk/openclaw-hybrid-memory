/**
 * Default required-step lists for hybrid-mem maintenance cron jobs.
 * Used by verify --reconcile and `hybrid-mem reconcile-cron-ledgers`.
 */
export const HYBRID_MEM_CRON_DEFAULT_JOB_STEPS: Record<string, string[]> = {
  "hybrid-mem:nightly-memory-sweep": ["prune", "distill", "extract-daily", "resolve-contradictions", "enrich-entities"],
  "hybrid-mem:nightly-dream-cycle": ["dream-cycle"],
  "hybrid-mem:weekly-reflection": ["reflect", "reflect-rules"],
  "hybrid-mem:nightly-self-correction": ["self-correct"],
  "hybrid-mem:weekly-sensor-sweep": ["sensor-sweep"],
  "hybrid-mem:weekly-persona-proposals": ["persona-proposals"],
};
