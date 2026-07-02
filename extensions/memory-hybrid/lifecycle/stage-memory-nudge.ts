/**
 * Memory nudge injection on session start (Issue #1916).
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import {
  buildMemoryNudge,
  formatMemoryNudgeBlock,
  shouldEmitNudge,
  recordNudgeEmission,
  DEFAULT_MEMORY_NUDGE_CONFIG,
} from "../services/memory-nudge.js";
import { applyPrependBudget } from "../services/prepend-budget.js";
import { runOptionalBeforeAgentStartStage } from "../services/before-agent-start-budget.js";
import type { LifecycleContext } from "./types.js";
import { withHookResolutionApi } from "./hook-resolution-api.js";
import { resolveSessionKeyFromHookEvent } from "./session-state.js";

export function registerMemoryNudgeInjection(api: ClawdbotPluginApi, ctx: LifecycleContext): void {
  const nudgeCfg = ctx.cfg.retrieval?.recallFeedback?.nudge;
  if (!nudgeCfg?.enabled) return;

  api.on("before_agent_start", async (event: unknown, hookCtx: unknown) =>
    runOptionalBeforeAgentStartStage(ctx.beforeAgentStartTurnRef, "memory-nudge", api.logger, async () => {
    const rApi = withHookResolutionApi(api, hookCtx);
    const sessionKey = resolveSessionKeyFromHookEvent(event, rApi) ?? "default";
    const throttleHours = nudgeCfg.throttleHours ?? DEFAULT_MEMORY_NUDGE_CONFIG.throttleHours;
    if (!shouldEmitNudge(sessionKey, throttleHours)) return undefined;

    const config = {
      ...DEFAULT_MEMORY_NUDGE_CONFIG,
      ...nudgeCfg,
      duplicateCandidateThreshold:
        nudgeCfg.duplicateCandidateThreshold ?? DEFAULT_MEMORY_NUDGE_CONFIG.duplicateCandidateThreshold,
      neverReferencedThreshold:
        nudgeCfg.neverReferencedThreshold ?? DEFAULT_MEMORY_NUDGE_CONFIG.neverReferencedThreshold,
    };
    const nudge = buildMemoryNudge(ctx.factsDb.getRawDb(), config);
    if (!nudge || nudge.actions.length === 0) return undefined;

    recordNudgeEmission(sessionKey);
    const block = formatMemoryNudgeBlock(nudge, config.maxTokens);
    const prepend = applyPrependBudget(ctx.prependBudgetRef, `${block}\n\n`);
    if (!prepend) return undefined;
    return { prependContext: prepend };
  }),
  );
}
