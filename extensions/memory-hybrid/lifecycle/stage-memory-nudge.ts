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
import type { LifecycleContext } from "./types.js";
import { withHookResolutionApi } from "./hook-resolution-api.js";

export function registerMemoryNudgeInjection(api: ClawdbotPluginApi, ctx: LifecycleContext): void {
  const nudgeCfg = ctx.cfg.retrieval?.recallFeedback?.nudge;
  if (!nudgeCfg?.enabled) return;

  api.on("before_agent_start", async (_event: unknown, hookCtx: unknown) => {
    const rApi = withHookResolutionApi(api, hookCtx);
    const sessionKey = rApi.context?.sessionKey ?? "default";
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
    const block = formatMemoryNudgeBlock(nudge);
    return { prependContext: `${block}\n\n` };
  });
}
