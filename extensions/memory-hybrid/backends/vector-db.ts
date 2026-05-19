/**
 * LanceDB vector backend for semantic search.
 */
export { VectorDB } from "./vector-db/vector-db-class.js";
export type { VectorDBLogger } from "./vector-db/constants.js";
export { isPathInsideDir, resolvedPathOrFallback } from "./vector-db/path-utils.js";
