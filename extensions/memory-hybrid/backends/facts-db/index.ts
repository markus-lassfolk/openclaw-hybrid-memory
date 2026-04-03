/**
 * Public barrel for the SQLite facts backend (Issue #954).
 * Implementation remains in `../facts-db.ts`; extracted helpers live in sibling modules under this folder.
 */
export { FactsDB, type ContradictionRecord } from "../facts-db.js";
export {
  MEMORY_LINK_TYPES,
  type MemoryLinkType,
  type ReinforcementContext,
} from "./types.js";
