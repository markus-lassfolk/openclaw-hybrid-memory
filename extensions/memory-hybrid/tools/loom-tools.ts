/**
 * The Loom (Epic #2150) — agent-facing tool registration barrel.
 *
 * Composes every Loom sub-registrar (evidence capsules #2148, belief graph
 * #2151, live checks #2156, open loops #2152, drift scout #2146, lifecycle
 * #2155, attention steward #2153, loom brief #2154, agent runway #2145) into
 * one installer entry so `setup/tool-installers.ts` only has to gate on
 * `cfg.loom.enabled && ctx.loomStore` once.
 */
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { BuildToolScopeFilterFn } from "../api/memory-plugin-api.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { LoomStore } from "../backends/loom-store.js";
import type { SerendipityStore } from "../backends/serendipity-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { registerAttentionTools } from "./attention-tools.js";
import { registerBeliefTools } from "./belief-tools.js";
import { registerDriftTools } from "./drift-tools.js";
import { registerEvidenceTools } from "./evidence-tools.js";
import { registerLifecycleTools } from "./lifecycle-tools.js";
import { registerLiveCheckTools } from "./live-check-tools.js";
import { registerLoomBriefTools } from "./loom-brief-tools.js";
import { registerOpenLoopTools } from "./open-loop-tools.js";
import { registerRunwayTools } from "./runway-tools.js";

export interface LoomToolsContext {
  loomStore: LoomStore;
  factsDb: FactsDB;
  serendipityStore?: SerendipityStore | null;
  cfg: HybridMemoryConfig;
  currentAgentIdRef: { value: string | null };
  buildToolScopeFilter: BuildToolScopeFilterFn;
  workspaceRoot?: string;
}

export function registerLoomTools(ctx: LoomToolsContext, api: ClawdbotPluginApi): void {
  registerEvidenceTools(ctx, api);
  registerBeliefTools(ctx, api);
  registerLiveCheckTools(ctx, api);
  registerOpenLoopTools(ctx, api);
  registerDriftTools(ctx, api);
  registerLifecycleTools(ctx, api);
  registerAttentionTools(ctx, api);
  registerLoomBriefTools(ctx, api);
  registerRunwayTools(ctx, api);
}
