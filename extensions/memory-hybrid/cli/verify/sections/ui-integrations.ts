import { getEnv } from "../../../utils/env-manager.js";
import { resolveOpenClawWorkspaceRoot } from "../../../utils/openclaw-workspace.js";
import { WIKI_WORKSPACE_EXPORT_SUBDIR } from "../../../services/wiki-workspace-export.js";
import type { VerifyRunState } from "../verify-run-state.js";
import { inspectWikiWorkspaceMirror, probeWorkboardRpc } from "../ui-integration-checks.js";

export async function runVerifyUiIntegrationsSection(state: VerifyRunState): Promise<void> {
  const { cfg, factsDb, log, OK, WARN_LINE, noEmoji, warnings } = state;
  const wiki = cfg.wikiIntegration;
  const workboard = cfg.workboard;

  if (!wiki?.enabled && !workboard?.enabled) return;

  log("\n───── UI integrations (Workboard / Dreaming) ─────");

  if (wiki?.enabled) {
    log(`${OK} Wiki integration enabled`);
    log(`  publicArtifacts (RPC bridge): ${wiki.publicArtifacts ? "on" : "off"}`);
    log(`  corpusSupplement (corpus=all): ${wiki.corpusSupplement ? "on" : "off"}`);
    log(`  fact mutations (bidirectional edit): ${wiki.mutations.enabled ? "on" : "off"}`);

    if (wiki.publicArtifacts) {
      log("  Primary Dreaming import path: publicArtifacts.listArtifacts() via registerMemoryCapability");
    } else {
      log(`${WARN_LINE} publicArtifacts off — Dreaming UI bridge import will not see hybrid-memory facts`);
      warnings.push("wiki integration: publicArtifacts disabled");
    }

    const mirror = inspectWikiWorkspaceMirror(cfg, resolveOpenClawWorkspaceRoot(), factsDb);
    if (mirror.enabled) {
      log(`  workspace mirror: on (every ${mirror.intervalMinutes} min) → ${WIKI_WORKSPACE_EXPORT_SUBDIR}/`);
      if (mirror.directoryExists) {
        log(
          `    ${OK} Mirror directory present — ${mirror.markdownFileCount} markdown file(s), ${mirror.exportableFactCount} exportable fact(s) in DB`,
        );
        if (mirror.lastSyncedAt) {
          log(
            `    Last sync: ${mirror.lastSyncedAt}${mirror.lastSyncFactCount != null ? ` (${mirror.lastSyncFactCount} facts)` : ""}`,
          );
        }
        if (mirror.lastSyncFactCount != null && mirror.lastSyncFactCount < mirror.exportableFactCount) {
          log(`${WARN_LINE} Mirror may be stale — run \`openclaw hybrid-mem wiki export\` or wait for the next timer tick`);
          warnings.push("wiki integration: workspace mirror fact count lags database");
        }
      } else {
        log(
          `${WARN_LINE} Mirror directory missing — run \`openclaw hybrid-mem wiki export\` or restart gateway with wiki integration enabled`,
        );
        warnings.push("wiki integration: workspace mirror directory missing");
      }
    } else {
      log("  workspace mirror: off (workspaceExportIntervalMinutes: 0)");
    }

    if (wiki.corpusSupplement) {
      log("  corpus supplement registers hybrid-memory facts for memory_search / wiki_search corpus=all");
    }

    if (!wiki.mutations.enabled) {
      log(
        `${noEmoji ? "[INFO]" : "ℹ️"}  Bidirectional wiki edits require wikiIntegration.mutations.enabled (registers hybrid-mem.facts.* RPC + HTTP)`,
      );
    }
  }

  if (workboard?.enabled) {
    log(`${OK} Workboard integration enabled`);
    log(
      `  syncTasks: ${workboard.syncTasks ? "on" : "off"}, syncGoals: ${workboard.syncGoals ? "on" : "off"}, bidirectional: ${workboard.bidirectional ? "on" : "off"}`,
    );
    log(`  gatewayUrl: ${workboard.gatewayUrl}, interval: ${workboard.syncIntervalMinutes} min, tag: ${workboard.cardTag}`);

    const token = getEnv("OPENCLAW_GATEWAY_TOKEN")?.trim() || undefined;
    const probe = await probeWorkboardRpc(workboard.gatewayUrl, token);
    if (probe.ok) {
      log(`  ${OK} Workboard RPC reachable at ${probe.gatewayUrl}`);
    } else {
      log(`  ${WARN_LINE} Workboard RPC unreachable: ${probe.error ?? "unknown error"}`);
      warnings.push(`workboard: RPC unreachable (${probe.error ?? "probe failed"})`);
    }

    if (workboard.syncGoals && !cfg.goalStewardship?.enabled) {
      log(`${WARN_LINE} syncGoals enabled but goal stewardship is off — goal cards will not sync`);
      warnings.push("workboard: syncGoals enabled without goal stewardship");
    }
  }
}
