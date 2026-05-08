/**
 * Public barrel for the SQLite facts backend (Issue #954).
 * `FactsDB` lives in `../facts-db.ts`; focused helpers live in sibling modules.
 */
export { FactsDB, type ContradictionRecord } from "../facts-db.js";
export { DASHBOARD_TIER_FILTER, DECAY_CLASS_FILTER } from "./stats.js";
export { scopeFilterClauseNamed, scopeFilterClausePositional } from "./scope-sql.js";
export {
  bufferToFloat32Array,
  countCanonicalEmbeddings,
  deleteEmbeddings,
  deleteVariants,
  estimateStorageBytesOnDisk,
  getEmbeddings,
  getEmbeddingsByModel,
  getVariants,
  hasVariants,
  storeEmbedding,
  storeVariant,
} from "./variants.js";
export {
  MEMORY_LINK_TYPES,
  type MemoryLinkType,
  type ReinforcementContext,
  type ReinforcementEvent,
} from "./types.js";
export { rowToMemoryEntry } from "./row-mapper.js";
export {
  deleteFact,
  getDuplicateIdByNormalizedHash,
  hasDuplicateText,
  refreshAccessedFacts,
  storeFact,
  type StoreFactInput,
  validateStoreEntryInput,
} from "./crud.js";
export {
  findByIdPrefix,
  findByIdPrefixScoped,
  getSupersededTextsSnapshot,
  lookupFacts,
  searchFacts,
} from "./search.js";
export {
  confirmFact,
  decayConfidence,
  logRecall,
  promoteScope,
  pruneExpired,
  pruneRecallLog,
  pruneSessionScope,
  restoreCheckpoint,
  runCompaction,
  saveCheckpoint,
  setFactTier,
  setPreserveTags,
  setPreserveUntil,
  trimToBudget,
} from "./maintenance.js";
export {
  countExpiredFacts,
  countFacts,
  directivesCount,
  entityCount,
  estimateStoredTokens,
  estimateStoredTokensByTier,
  getTokenBudgetStatus,
  linksCount,
  listForDashboard,
  metaPatternsCount,
} from "./stats.js";
