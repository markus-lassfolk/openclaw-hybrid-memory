/**
 * Root `--version` / `--json` wiring for hybrid-mem (issue #2012).
 */

import type { Command } from "commander";
import { runHybridMemVersion } from "./cmd-version.js";
import { versionInfo } from "../versionInfo.js";

const VERSION_FLAG_DESC = "Show installed plugin version and check for updates";
const VERSION_JSON_DESC = "Machine-readable JSON output (use with --version)";

/** Register root `--version` handling on the hybrid-mem Commander node. */
export function registerHybridMemVersionFlag(mem: Command): void {
  mem.option("--version", VERSION_FLAG_DESC);
  mem.option("--json", VERSION_JSON_DESC);

  mem.action(async () => {
    const opts = mem.opts() as { version?: boolean; json?: boolean };
    if (!opts.version) return;
    await runHybridMemVersion(versionInfo.pluginVersion, { json: opts.json, format: "flag" });
    process.exit(0);
  });
}
