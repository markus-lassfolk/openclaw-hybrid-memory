import { parseConfig } from "./parsers/index.js";

/**
 * Runtime config validation entry point (issue #866).
 * Uses the same parser pipeline as plugin registration; throws on invalid hybrid config.
 */
export const hybridConfigSchema = {
  parse: parseConfig,
};
