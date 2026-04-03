/**
 * SQLite + FTS5 backend for structured facts.
 *
 * Implementation is split across `facts-db-layer1.ts`–`facts-db-layer3.ts` for maintainability;
 * this module re-exports the public `FactsDB` class.
 */

export { FactsDB } from "./facts-db-layer3.js";
