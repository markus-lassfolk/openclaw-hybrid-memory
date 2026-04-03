/**
 * Public barrel for the SQLite facts backend (Issue #954).
 * `FactsDB` lives in `../facts-db.ts`; focused helpers live in sibling modules (e.g. `stats.ts`).
 */
export { FactsDB, type ContradictionRecord } from "../facts-db.js";
export { DASHBOARD_TIER_FILTER, DECAY_CLASS_FILTER } from "./stats.js";
export {
  MEMORY_LINK_TYPES,
  type MemoryLinkType,
  type ReinforcementContext,
  type ReinforcementEvent,
} from "./types.js";
