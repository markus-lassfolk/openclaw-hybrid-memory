/**
 * Live directive/correction nudge on before_agent_start.
 * When the user's message signals a correction or explicit memory request,
 * prepend a block urging immediate memory_store (complements agent_end auto-capture).
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { detectUserStoreDirective } from "../services/directive-extract.js";
import { formatDirectiveStoreNudgeBlock } from "../services/directive-store-nudge.js";
import { applyPrependBudget } from "../services/prepend-budget.js";
import { runOptionalBeforeAgentStartStage } from "../services/before-agent-start-budget.js";
import type { LifecycleContext } from "./types.js";
import { withHookResolutionApi } from "./hook-resolution-api.js";

export function registerDirectiveStoreNudge(api: ClawdbotPluginApi, ctx: LifecycleContext): void {
  if (!ctx.cfg.autoCapture || !ctx.cfg.autoRecall.enabled || ctx.cfg.verbosity === "silent") return;

  api.on("before_agent_start", async (event: unknown, hookCtx: unknown) =>
    runOptionalBeforeAgentStartStage(ctx.beforeAgentStartTurnRef, "directive-store-nudge", api.logger, async () => {
    const rApi = withHookResolutionApi(api, hookCtx);
    const e = event as {
      prompt?: string;
      messages?: Array<{ role?: string; content?: unknown }>;
    };

    let userContent: string | undefined;
    if (typeof e.prompt === "string" && e.prompt.trim().length > 0) {
      userContent = e.prompt;
    } else if (Array.isArray(e.messages)) {
      const userMsgs = e.messages.filter((m) => m && typeof m === "object" && m.role === "user");
      const lastUser = userMsgs[userMsgs.length - 1];
      if (lastUser && typeof lastUser.content === "string") userContent = lastUser.content;
    }

    if (!userContent || userContent.trim().length < 15) return undefined;

    const directive = detectUserStoreDirective(userContent);
    if (!directive) return undefined;

    const block = formatDirectiveStoreNudgeBlock(directive);
    const prepend = applyPrependBudget(ctx.prependBudgetRef, `${block}\n\n`);
    if (!prepend) return undefined;

    rApi.logger?.debug?.(
      `memory-hybrid: directive store nudge (${directive.categories.join(", ")}) textLen=${directive.storeText.length}`,
    );
    return { prependContext: prepend };
  }),
  );
}
