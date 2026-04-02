/**
 * Memory Manager version metadata — single source for upgrades and releases.
 * Plugin version is read from package.json; memory-manager and schema versions
 * are defined here and aligned with docs (hybrid-memory-manager-v3.md) and DB.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("./package.json") as { version: string };

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
