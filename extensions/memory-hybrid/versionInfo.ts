/**
 * Memory Manager version metadata — single source for upgrades and releases.
 * Plugin version is read from package.json; memory-manager and schema versions
 * are defined here and aligned with docs (hybrid-memory-manager-v3.md) and DB.
 *
 * The version is resolved via the plugin-root walk-up helper so it works
 * regardless of whether the runtime entry is the TS source or the compiled
 * `dist/index.js` (issue #1174).
 */

import { readPluginPackageJson } from "./utils/plugin-root.js";

const pkg = readPluginPackageJson(import.meta.url);

/** Plugin release version (from package.json). Bump on each release. */
const pluginVersion: string = pkg.version;

/** Memory Manager spec version — matches docs/hybrid-memory-manager-v3.md "Version: X.Y". */
const memoryManagerVersion = "3.0";

/** Schema version for SQLite/LanceDB. Bump when adding migrations or breaking schema changes. */
const schemaVersion = 3;

export const versionInfo = {
  pluginVersion,
  memoryManagerVersion,
  schemaVersion,
} as const;
