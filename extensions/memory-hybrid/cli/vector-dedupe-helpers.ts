/**
 * Re-export shim (#2091): this logic now lives in `services/vector-dedupe-helpers.ts` so
 * services-layer callers (e.g. `services/consolidation.ts`) can use it too without inverting the
 * documented cli -> services dependency direction (CLAUDE.md). Existing cli/tools/lifecycle
 * imports of this path keep working unchanged.
 */
export * from "../services/vector-dedupe-helpers.js";
