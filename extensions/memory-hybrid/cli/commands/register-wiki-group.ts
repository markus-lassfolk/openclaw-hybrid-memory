import { capturePluginError } from "../../services/error-reporter.js";
import type { ManageContext } from "../context.js";
import { type Chainable, withExit } from "../shared.js";
import { syncWikiWorkspaceExport, WIKI_WORKSPACE_EXPORT_SUBDIR } from "../../services/wiki-workspace-export.js";
import { resolveOpenClawWorkspaceRoot } from "../../utils/openclaw-workspace.js";

export function registerWikiGroup(mem: Chainable, ctx: ManageContext): void {
  const wiki = mem
    .command("wiki")
    .description("Wiki integration utilities (Dreaming UI / memory-wiki bridge)");

  wiki
    .command("export")
    .description("Sync facts to workspace markdown mirror (memory/hybrid-wiki/)")
    .option("--json", "Output result as JSON")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        if (!ctx.cfg.wikiIntegration?.enabled) {
          const msg = "wiki integration is disabled (set wikiIntegration.enabled: true)";
          if (opts?.json) {
            console.log(JSON.stringify({ ok: false, error: msg }));
          } else {
            console.error(`Error: ${msg}`);
          }
          process.exitCode = 1;
          return;
        }

        try {
          const workspaceRoot = resolveOpenClawWorkspaceRoot();
          const result = syncWikiWorkspaceExport(ctx.factsDb, workspaceRoot);
          const payload = {
            ok: true,
            exportRoot: result.exportRoot,
            relativePath: WIKI_WORKSPACE_EXPORT_SUBDIR,
            factsWritten: result.factsWritten,
            factsSkipped: result.factsSkipped,
            filesRemoved: result.filesRemoved,
          };

          if (opts?.json) {
            console.log(JSON.stringify(payload, null, 2));
          } else {
            console.log(`Wiki workspace mirror synced → ${WIKI_WORKSPACE_EXPORT_SUBDIR}/`);
            console.log(
              `  wrote ${result.factsWritten}, skipped ${result.factsSkipped}, removed ${result.filesRemoved} stale file(s)`,
            );
            console.log(`  export root: ${result.exportRoot}`);
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "wiki-export",
          });
          if (opts?.json) {
            console.log(
              JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
            );
          }
          throw err;
        }
      }),
    );

  wiki
    .command("status")
    .description("Show wiki integration config and workspace mirror status")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const { inspectWikiWorkspaceMirror } = await import("../verify/ui-integration-checks.js");
        const wikiCfg = ctx.cfg.wikiIntegration;
        const mirror = inspectWikiWorkspaceMirror(ctx.cfg, resolveOpenClawWorkspaceRoot(), ctx.factsDb);

        const payload = {
          enabled: wikiCfg.enabled,
          publicArtifacts: wikiCfg.publicArtifacts,
          corpusSupplement: wikiCfg.corpusSupplement,
          workspaceExportIntervalMinutes: wikiCfg.workspaceExportIntervalMinutes,
          mutationsEnabled: wikiCfg.mutations.enabled,
          mirror,
        };

        if (opts?.json) {
          console.log(JSON.stringify(payload, null, 2));
          return;
        }

        console.log(`Wiki integration — ${wikiCfg.enabled ? "enabled" : "disabled"}`);
        if (!wikiCfg.enabled) return;

        console.log(`  publicArtifacts: ${wikiCfg.publicArtifacts ? "on" : "off"}`);
        console.log(`  corpusSupplement: ${wikiCfg.corpusSupplement ? "on" : "off"}`);
        console.log(`  mutations: ${wikiCfg.mutations.enabled ? "on" : "off"}`);
        console.log(
          `  workspace mirror: ${mirror.enabled ? `every ${mirror.intervalMinutes} min` : "off (interval 0)"}`,
        );
        if (mirror.directoryExists) {
          console.log(`  mirror files: ${mirror.markdownFileCount} markdown file(s)`);
          if (mirror.lastSyncedAt) console.log(`  last sync: ${mirror.lastSyncedAt}`);
        }
        console.log(`  exportable facts in DB: ${mirror.exportableFactCount}`);
        console.log(`  Run manual sync: openclaw hybrid-mem wiki export`);
      }),
    );
}
