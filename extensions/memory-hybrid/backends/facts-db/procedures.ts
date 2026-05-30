/**
 * Procedural memory procedures — barrel re-export (split modules).
 */
export type {
  ProcedurePromotionBlockReason,
  ProcedureTriageRow,
  ProcedureTriageSummary,
  ProcedureTriageReport,
} from "./procedures/types.js";
export {
  enrichProcedureWithFeedback,
  procedureRowToEntry,
  procedureFeedback,
  getProcedureVersions,
  getProcedureFailures,
  upsertProcedure,
  listProcedures,
  listProceduresUpdatedInLastNDays,
  getProcedureById,
  findProcedureByTaskPattern,
} from "./procedures/crud.js";
export {
  searchProcedures,
  searchProceduresRanked,
  getNegativeProceduresMatching,
} from "./procedures/search.js";
export {
  recordProcedureSuccess,
  recordProcedureFailure,
  getProceduresReadyForSkill,
  markProcedurePromoted,
  triageProcedures,
  getStaleProcedures,
} from "./procedures/promotion.js";
export {
  getProceduresForAudit,
  proceduresCount,
  proceduresValidatedCount,
  proceduresValidatedSince,
  proceduresPromotedCount,
} from "./procedures/stats.js";
export { PROCEDURE_BLOCK_REASONS } from "./procedures/internal.js";
