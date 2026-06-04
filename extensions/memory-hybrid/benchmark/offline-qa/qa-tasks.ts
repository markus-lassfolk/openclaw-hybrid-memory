/** Ordered maintenance tasks for per-task offline QA (mirrors run-all). */

export type QaTaskClassification =
  | "ok"
  | "by-design-zero"
  | "data-gap"
  | "test-bug"
  | "needs-fix"
  | "skipped"
  | "pending";

export type QaTaskSpec = {
  id: string;
  /** openclaw hybrid-mem args after the subcommand name */
  args: string[];
  /** Human expectation for analysis */
  expectation: string;
  /** Uses embeddings / vectors — may degrade if embedding key fails */
  vectorDependent?: boolean;
  /** Uses maintenance-tier LLM */
  llmTask?: boolean;
  /** Step may be absent from CLI (e.g. reflect-identity) */
  skipIfCommandMissing?: boolean;
  /** Gate documented in run-all (informational) */
  runAllGate?: string;
};

export const QA_TASK_PLAN: QaTaskSpec[] = [
  {
    id: "backfill-decay",
    args: ["backfill-decay", "--verbose"],
    expectation: "Backfills decay columns once; may report 0 if already backfilled.",
    runAllGate: "Skipped if .backfill-decay-done marker exists",
  },
  {
    id: "prune",
    args: ["prune", "--verbose"],
    expectation: "Prunes expired facts; 0 is ok if nothing expired.",
    vectorDependent: true,
  },
  {
    id: "compact",
    args: ["compact", "--verbose"],
    expectation: "Retiers facts hot/warm/cold; reports tier counts.",
  },
  {
    id: "distill",
    args: ["distill", "--days", "3", "--verbose", "--force"],
    expectation: "Scans recent sessions and stores distilled facts; expect sessionsScanned > 0.",
    vectorDependent: true,
    llmTask: true,
  },
  {
    id: "extract-daily",
    args: ["extract-daily", "--days", "7", "--verbose", "--force"],
    expectation: "Reads memory/YYYY-MM-DD.md daily logs; expect files in sandbox memory/.",
    vectorDependent: true,
    llmTask: true,
  },
  {
    id: "extract-directives",
    args: ["extract-directives", "--days", "60", "--verbose", "--force"],
    expectation: "Scans main agent sessions for directives; 0 stored ok if none found.",
    llmTask: true,
  },
  {
    id: "extract-reinforcement",
    args: ["extract-reinforcement", "--days", "60", "--verbose", "--force"],
    expectation: "Finds reinforcement incidents; corpus may have RE=0 (data gap).",
    llmTask: true,
  },
  {
    id: "extract-implicit",
    args: ["extract-implicit", "--days", "60", "--verbose", "--force"],
    expectation: "Extracts implicit feedback signals from sessions.",
    llmTask: true,
  },
  {
    id: "extract-procedures",
    args: ["extract-procedures", "--days", "60", "--verbose", "--force"],
    expectation: "Extracts procedure facts; 0 ok if procedures.enabled=false or none found.",
    llmTask: true,
  },
  {
    id: "generate-auto-skills",
    args: ["generate-auto-skills", "--apply", "--verbose"],
    expectation: "Generates skill drafts from validated procedures; 0 ok if no procedures.",
    llmTask: true,
  },
  {
    id: "reflect",
    args: ["reflect", "--verbose", "--force"],
    expectation: "Stores reflection patterns from recent facts; expect factsAnalyzed > 0.",
    vectorDependent: true,
    llmTask: true,
  },
  {
    id: "reflect-rules",
    args: ["reflect-rules", "--verbose", "--force"],
    expectation: "Stores rules from patterns; skipped in run-all if <3 patterns.",
    llmTask: true,
    runAllGate: "Needs ≥3 live patterns",
  },
  {
    id: "reflect-meta",
    args: ["reflect-meta", "--verbose", "--force"],
    expectation: "Stores meta-patterns; skipped in run-all if <3 patterns.",
    llmTask: true,
    runAllGate: "Needs ≥3 live patterns",
  },
  {
    id: "reflect-identity",
    args: ["reflect-identity", "--verbose"],
    expectation: "Identity reflection; may be unregistered in default CLI context.",
    llmTask: true,
    skipIfCommandMissing: true,
  },
  {
    id: "generate-proposals",
    args: ["generate-proposals", "--verbose"],
    expectation: "Creates persona proposals from patterns; 0 ok if no patterns.",
    llmTask: true,
  },
  {
    id: "self-correction-run",
    args: ["self-correction-run", "--days", "60", "--verbose", "--force"],
    expectation: "Scans sessions for correction incidents; 0 ok if none in window.",
    llmTask: true,
  },
  {
    id: "build-languages",
    args: ["build-languages", "--verbose"],
    expectation: "Rebuilds language keywords; may skip if mtime < 7 days.",
    llmTask: true,
    runAllGate: "Skipped if keywords updated <7d ago",
  },
];

export const QA_PHASE_TIMEOUT_MS = {
  fast: 180_000,
  full: 1_200_000,
} as const;

export type QaPhase = keyof typeof QA_PHASE_TIMEOUT_MS;
