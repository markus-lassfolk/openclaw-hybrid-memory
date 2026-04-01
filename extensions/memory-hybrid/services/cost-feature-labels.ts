/**
 * Canonical `feature` strings for LLM cost tracking (`llm_cost_log`, #961).
 * Kebab-case; pass to `chatComplete({ feature })` / `chatCompleteWithRetry({ feature })`.
 */
export const CostFeature = {
  queryExpansion: "query-expansion",
  reranking: "reranking",
  hyde: "hyde",
  contextualVariants: "contextual-variants",
  retrievalAliases: "retrieval-aliases",
  sessionPreFilter: "session-pre-filter",
  passiveObserver: "passive-observer",
  documentGrader: "document-grader",
  documentGraderQueryRewrite: "document-grader-query-rewrite",
  continuousVerifier: "continuous-verifier",
  monthlyReviewRecommendations: "monthly-review-recommendations",
  monthlyReviewUncoveredDomains: "monthly-review-uncovered-domains",
  multiPassExtractorPass1: "multi-pass-extractor-pass1",
  multiPassExtractorPass2: "multi-pass-extractor-pass2",
  multiPassExtractorPass3: "multi-pass-extractor-pass3",
  memoryIndex: "memory-index",
  sessionNarrative: "session-narrative",
  distillCli: "distill-cli",
  extractReinforcement: "extract-reinforcement",
  generateProposals: "generate-proposals",
  selfCorrectionAnalyze: "self-correction-analyze",
  selfCorrectionRewriteTools: "self-correction-rewrite-tools",
  backfillSentiment: "backfill-sentiment",
  backfillIngest: "backfill-ingest",
  verifyCliLlm: "verify-cli-llm",
  trajectoryAnalyze: "trajectory-analyze",
} as const;

export type CostFeatureId = (typeof CostFeature)[keyof typeof CostFeature];
