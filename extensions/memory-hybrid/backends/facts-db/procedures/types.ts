/**
 * Procedure types (split from procedures.ts).
 */

export type ProcedurePromotionBlockReason =
  | "duplicate_skill"
  | "low_recall"
  | "missing_anchor"
  | "awaiting_approval"
  | "unknown";

export type ProcedureTriageRow = {
  id: string;
  title: string;
  validatedAt: number | null;
  promotionBlockReason: ProcedurePromotionBlockReason;
  lastRecall: number | null;
  successCount: number;
  confidence: number;
  skillPath: string | null;
};

export type ProcedureTriageSummary = {
  total: number;
  byReason: Record<ProcedurePromotionBlockReason, number>;
  topReason: ProcedurePromotionBlockReason | null;
};

export type ProcedureTriageReport = {
  rows: ProcedureTriageRow[];
  summary: ProcedureTriageSummary;
};
