/** Agent Runway API tool (Issue #2145) — compact preflight context, front door to the Loom. */
import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { FactsDB } from "../backends/facts-db.js";
import type { LoomStore } from "../backends/loom-store.js";
import type { SerendipityStore } from "../backends/serendipity-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { buildRunway } from "../services/agent-runway.js";
import { capturePluginError } from "../services/error-reporter.js";
import { resolveGoalsDir } from "../services/goal-stewardship.js";

export interface RunwayToolsContext {
  loomStore: LoomStore | null;
  factsDb: FactsDB;
  serendipityStore?: SerendipityStore | null;
  cfg: HybridMemoryConfig;
  workspaceRoot?: string;
}

export function registerRunwayTools(ctx: RunwayToolsContext, api: ClawdbotPluginApi): void {
  const { loomStore, factsDb, serendipityStore, cfg, workspaceRoot } = ctx;
  const lc = cfg.loom;

  api.registerTool(
    {
      name: "memory_runway",
      label: "Agent Runway",
      description:
        "Return the minimal, bounded context an agent should inspect before doing work: active tasks, goals, fragile surfaces, and a Loom summary (beliefs, required live checks, open loops, drift warnings, attention priorities). Never includes credential values.",
      parameters: Type.Object({
        agent: Type.Optional(Type.String()),
        scope: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!lc.enabled || !lc.runway.enabled) {
          return {
            content: [
              { type: "text", text: "The Loom runway is disabled. Set loom.enabled and loom.runway.enabled: true." },
            ],
            details: { error: "loom_disabled" },
          };
        }
        try {
          const p = params as { agent?: string; scope?: string };
          const goalsDir = workspaceRoot
            ? resolveGoalsDir(workspaceRoot, cfg.goalStewardship?.goalsDir ?? ".openclaw/goals")
            : undefined;
          const bundle = await buildRunway(
            { factsDb, loomStore, serendipityStore, goalsDir },
            { agent: p.agent, scope: p.scope, maxItemsPerSection: lc.runway.maxItemsPerSection },
          );
          return {
            content: [
              {
                type: "text",
                text: `Runway: ${bundle.activeTasks.length} active task(s), ${bundle.goals.length} goal(s), ${bundle.loom.openLoops.length} open loop(s), ${bundle.loom.mustLiveCheck.length} live check(s) pending.`,
              },
            ],
            details: bundle,
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "loom-runway",
            operation: "memory_runway",
          });
          return { content: [{ type: "text", text: String(err) }], details: { error: String(err) } };
        }
      },
    },
    { name: "memory_runway" },
  );
}
