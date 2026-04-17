/**
 * SQLite + FTS5 backend for structured facts — public entry (implementation in ./facts-db/facts-db-core.ts).
 */
export { FactsDB } from "./facts-db/facts-db-core.js";
export type { ContradictionRecord } from "./facts-db/contradictions.js";
export {
	MEMORY_LINK_TYPES,
	type MemoryLinkType,
	type ReinforcementContext,
} from "./facts-db/types.js";
