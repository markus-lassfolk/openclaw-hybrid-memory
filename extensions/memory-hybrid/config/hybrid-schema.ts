import { parseConfig } from "./parsers/index.js";

/** Zod-like wrapper used by the plugin object and `register()` config validation. */
export const hybridConfigSchema = {
  parse: parseConfig,
};
