/** Shared crystallization QA verdict helpers (testable, used by analyze-crystallization.ts). */

export const USEFULNESS_LABEL_SEP = " — ";
export const USEFULNESS_BUCKET_GARBAGE = "garbage";
export const USEFULNESS_BUCKET_POTENTIALLY = "potentially useful";

export function usefulnessBucketKey(label: string): string {
  return label.split(USEFULNESS_LABEL_SEP)[0]?.trim() ?? label;
}

export function countUsefulnessBuckets(labels: readonly string[]): Record<string, number> {
  return labels.reduce<Record<string, number>>((acc, label) => {
    const bucket = usefulnessBucketKey(label);
    acc[bucket] = (acc[bucket] ?? 0) + 1;
    return acc;
  }, {});
}

export type CrystallizationVerdictInput = {
  dataGapOk: boolean;
  liveProdCandidates: number;
  userFacingCandidates: number;
  structuralCandidates: number;
  prodCandidates: number;
  liveWfStats: { sinceWindow: number } | null;
  unknownOutcomeShare: number;
  validationSummary: { deny: number; allow: number };
  usefulnessCounts: Record<string, number>;
};

export function pickCrystallizationVerdict(input: CrystallizationVerdictInput): string {
  const {
    dataGapOk,
    liveProdCandidates,
    userFacingCandidates,
    structuralCandidates,
    prodCandidates,
    liveWfStats,
    unknownOutcomeShare,
    validationSummary,
    usefulnessCounts,
  } = input;

  if (!dataGapOk) {
    return "INCONCLUSIVE — session coverage has multi-day gaps in the window.";
  }
  if (liveProdCandidates > 0) {
    return "PROMISING WITH LIVE TRACES — production gates pass on Maeve workflow-traces.db; review proposals manually.";
  }
  if (userFacingCandidates === 0 && structuralCandidates > 0) {
    return "MOSTLY GARBAGE — repeatable patterns are cron/system prompts, not user-facing workflows.";
  }
  if (prodCandidates === 0 && structuralCandidates === 0) {
    return "NOT READY — no repeatable tool patterns at minimum usage thresholds.";
  }
  if (prodCandidates === 0 && liveWfStats && liveWfStats.sinceWindow > 0) {
    return "LOW SUCCESS RATE — live traces exist but minSuccessRate (0.7) eliminates all production candidates.";
  }
  if (prodCandidates === 0 && unknownOutcomeShare > 0.5) {
    return "BLOCKED ON OUTCOMES — most backfill traces still have outcome=unknown; rely on live workflowTracking.";
  }
  if (validationSummary.deny > validationSummary.allow) {
    return "MOSTLY GARBAGE — validation denies more samples than it allows.";
  }
  if ((usefulnessCounts[USEFULNESS_BUCKET_POTENTIALLY] ?? 0) >= 4) {
    return "PROMISING — several candidates look actionable with real goals.";
  }
  if ((usefulnessCounts[USEFULNESS_BUCKET_GARBAGE] ?? 0) >= 8) {
    return "MOSTLY GARBAGE — top patterns are cron/system prompts despite passing validation.";
  }
  return "MIXED — some structure, but many skills are generic boilerplate.";
}
