/**
 * hybrid-mem install-index — reconcile stale legacy plugin install-index entries (issue #2008).
 *
 * `openclaw hybrid-mem install-index reconcile` inspects the legacy
 * `${stateDir}/plugins/installs.json` sidecar and, when it has a record that
 * conflicts with the live plugin path/version, atomically rewrites it (after
 * backing it up) so OpenClaw core state migrations stop emitting the
 * "Left plugin install index in place because shared SQLite state has
 * conflicting plugin install metadata" warning on every startup.
 */

import { PLUGIN_ID } from "../utils/constants.js";
import {
  detectStaleLegacyInstallIndexEntry,
  formatStaleInstallIndexWarning,
  reconcileLegacyInstallIndex,
  resolveLegacyInstallIndexPath,
} from "./install/install-index-reconcile.js";
import type { Chainable } from "./shared.js";

type ReconcileAction = () => Promise<void> | void;

export function registerInstallIndexCommand(program: Chainable, deps?: { reconcile?: ReconcileAction }): void {
  const sub = program
    .command("install-index")
    .description("Inspect or reconcile the legacy OpenClaw plugin install-index sidecar (issue #2008)");

  sub
    .command("status")
    .description("Show the stale install-index detection for this plugin")
    .action(() => {
      const detection = detectStaleLegacyInstallIndexEntry({ pluginId: PLUGIN_ID });
      const verdict = detection.verdict;
      const liveLine = `Live:   ${detection.livePath} (${detection.liveVersion ?? "<unknown>"})`;
      if (verdict === "no-conflict") {
        console.log(`Legacy install-index (${detection.legacyPath}): no entry for ${PLUGIN_ID}. Nothing to reconcile.`);
        console.log(liveLine);
        return;
      }
      if (verdict === "matches-live") {
        console.log(`Legacy install-index (${detection.legacyPath}) already points at the live plugin path/version.`);
        console.log(liveLine);
        return;
      }
      console.log(`Legacy install-index drift detected (${verdict}):`);
      console.log(
        `  Stale:  ${detection.staleInstallPath ?? "<unknown>"} (${detection.staleVersion ?? "<unknown>"}, source=${detection.staleSource ?? "<unknown>"})`,
      );
      console.log(`  ${liveLine}`);
      console.log(`  File:   ${detection.legacyPath}`);
      if (detection.detail) console.log(`  Detail: ${detection.detail}`);
      if (verdict === "safe-reconcile") {
        console.log("Repair: run `openclaw hybrid-mem install-index reconcile` to drop the stale entry.");
      } else {
        console.log(formatStaleInstallIndexWarning(detection));
      }
    });

  sub
    .command("reconcile")
    .description("Atomically rewrite the legacy install-index sidecar to remove the stale plugin entry")
    .option("--dry-run", "Show what would change without writing the sidecar")
    .option("--plugin-id <id>", "Plugin id to reconcile (defaults to openclaw-hybrid-memory)")
    .action(async (opts: { dryRun?: boolean; pluginId?: string }) => {
      const pluginId = opts.pluginId?.trim() || PLUGIN_ID;
      const detection = detectStaleLegacyInstallIndexEntry({ pluginId });
      const legacyPath = detection.legacyPath ?? resolveLegacyInstallIndexPath();
      if (detection.verdict === "no-conflict" || detection.verdict === "matches-live") {
        console.log(`install-index reconcile: nothing to do for ${pluginId} (${detection.verdict}).`);
        console.log(`Legacy file: ${legacyPath}`);
        return;
      }
      if (detection.verdict !== "safe-reconcile") {
        console.error(formatStaleInstallIndexWarning(detection));
        process.exitCode = 2;
        return;
      }
      if (opts.dryRun) {
        console.log(`install-index reconcile (dry-run): would drop stale ${pluginId} entry from ${legacyPath}`);
        console.log(`  Stale: ${detection.staleInstallPath} (${detection.staleVersion})`);
        console.log(`  Live:  ${detection.livePath} (${detection.liveVersion ?? "<unknown>"})`);
        return;
      }
      const result = reconcileLegacyInstallIndex({ detection, pluginId });
      if (!result.ok) {
        console.error(
          `install-index reconcile failed for ${pluginId} at ${legacyPath}: ${result.error ?? "unknown error"}`,
        );
        process.exitCode = 1;
        return;
      }
      if (result.action === "noop") {
        console.log(`install-index reconcile: nothing to do for ${pluginId} (${result.verdict}).`);
      } else {
        console.log(
          `install-index reconcile: dropped stale ${pluginId} entry from ${legacyPath} (backup at ${result.backupPath ?? "<unknown>"}).`,
        );
      }
      if (deps?.reconcile) await deps.reconcile();
    });
}
