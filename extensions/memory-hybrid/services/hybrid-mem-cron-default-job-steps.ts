/**
 * Default required-step lists for hybrid-mem maintenance cron jobs.
 */
const LEGACY_NIGHTLY_DISTILL_STEPS = ["prune", "distill", "resolve-contradictions", "enrich-entities"];

export const HYBRID_MEM_CRON_DEFAULT_JOB_STEPS: Record<string, string[]> = {
  "hybrid-mem:maintenance-nightly": ["maintenance-nightly"],
  "hybrid-mem:nightly-distill": LEGACY_NIGHTLY_DISTILL_STEPS,
  /** Legacy ledger basename if present; same steps as nightly-distill. */
  "hybrid-mem:nightly-memory-sweep": LEGACY_NIGHTLY_DISTILL_STEPS,
  "hybrid-mem:nightly-dream-cycle": ["dream-cycle"],
  "hybrid-mem:weekly-reflection": ["reflect", "reflect-rules", "reflect-meta"],
  "hybrid-mem:nightly-self-correction": ["self-correct"],
  "hybrid-mem:self-correction-analysis": ["self-correction-run"],
  "hybrid-mem:sensor-sweep": ["sensor-sweep-tier-1", "sensor-sweep-tier-2"],
  /** Legacy sensor-sweep job ID; validates single-step execution. */
  "hybrid-mem:weekly-sensor-sweep": ["sensor-sweep"],
  "hybrid-mem:weekly-persona-proposals": ["generate-proposals"],
  "hybrid-mem:weekly-extract-procedures": [
    "extract-procedures",
    "extract-directives",
    "extract-reinforcement",
    "generate-auto-skills",
  ],
  "hybrid-mem:weekly-deep-maintenance": ["compact", "vectordb-optimize", "scope-promote"],
  "hybrid-mem:monthly-consolidation": [
    "consolidate",
    "build-languages",
    "backfill-decay",
    "reembed-vectorless",
    "enrich-entities",
  ],
  "hybrid-mem:weekly-crystallization-skills-rescan": ["skills-rescan"],
  "hybrid-mem:daily-storage-growth-sample": ["record-storage-sample"],
  "hybrid-mem:weekly-implicit-feedback-collapse": ["reflect-meta-collapse"],
  "hybrid-mem:weekly-vectordb-optimize-sunday": ["vectordb-optimize"],
  "hybrid-mem:weekly-audit-health": ["audit-health"],
  "hybrid-mem:maintenance-log-analyzer": ["analyze-maintenance-logs"],
  "hybrid-mem:nightly-doctor-repair": ["doctor-fix-reconcile"],
  "hybrid-mem:weekly-pending-digest": ["digest-pending"],
  "hybrid-mem:weekly-pending-digest-autopilot": ["digest-autopilot-cron"],
  "hybrid-mem:daily-serendipity-sweep": ["serendipity-sweep"],
  /** Twice-daily operator reminder (#1921); same underlying command as weekly-pending-digest. */
  "hybrid-mem:workshop-approval-reminder": ["digest-pending"],
  "hybrid-mem:daily-lifecycle-sync": ["lifecycle-sync-github"],
};
