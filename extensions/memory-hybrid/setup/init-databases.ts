/** @module init-databases — Orchestration entry: database bootstrap and provider routing (see split modules). */
export { closeOldDatabases, initializeDatabases } from "./bootstrap-databases.js";
export { MINIMAX_BASE_URL, OPENROUTER_BASE_URL, resolveProviderApiKey } from "./provider-router.js";
