/** Drift scout tool (Issue #2146) — The Loom's immune system. */
import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { FactsDB } from "../backends/facts-db.js";
import type { LoomStore } from "../backends/loom-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { runDriftScout } from "../services/drift-scout.js";
import { capturePluginError } from "../services/error-reporter.js";
import { stringEnum } from "../utils/typebox.js";

export interface DriftToolsContext {
  loomStore: LoomStore;
  factsDb: FactsDB;
  cfg: HybridMemoryConfig;
}

export function registerDriftTools(ctx: DriftToolsContext, api: ClawdbotPluginApi): void {
  const { loomStore, factsDb, cfg } = ctx;
  const lc = cfg.loom;

  api.registerTool(
    {
      name: "memory_drift_scout",
      label: "Scan For Memory Drift",
      description:
        "Scan facts (and, when configured, cron/wiki/skills) for deprecated command references and unresolved contradictions. Report-only by default; set apply_safe to mechanically fix already-identified auto_safe deprecated-command findings.",
      parameters: Type.Object({
        include: Type.Optional(Type.Array(stringEnum(["cron", "skills", "wiki", "facts", "active_tasks"] as const))),
        apply_safe: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!lc.enabled || !lc.drift.enabled) {
          return {
            content: [
              {
                type: "text",
                text: "The Loom drift scout is disabled. Set loom.enabled and loom.drift.enabled: true.",
              },
            ],
            details: { error: "loom_disabled" },
          };
        }
        try {
          const p = params as {
            include?: Array<"cron" | "skills" | "wiki" | "facts" | "active_tasks">;
            apply_safe?: boolean;
          };
          const report = runDriftScout(
            { factsDb, loomStore },
            { include: p.include, applySafe: p.apply_safe === true, deprecatedCommands: lc.drift.deprecatedCommands },
          );
          return {
            content: [
              {
                type: "text",
                text:
                  report.findings.length === 0
                    ? "No drift detected."
                    : `${report.newCount} new, ${report.existingCount} existing drift finding(s)${report.appliedSafeCount > 0 ? `, ${report.appliedSafeCount} auto-fixed` : ""}:\n${report.findings
                        .slice(0, 20)
                        .map(
                          (f) =>
                            `- [${f.severity}/${f.repairability}] ${f.driftType}: ${f.oldText.slice(0, 80)} (id ${f.id.slice(0, 8)})`,
                        )
                        .join("\n")}`,
              },
            ],
            details: report,
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "loom-drift",
            operation: "memory_drift_scout",
          });
          return { content: [{ type: "text", text: String(err) }], details: { error: String(err) } };
        }
      },
    },
    { name: "memory_drift_scout" },
  );
}
