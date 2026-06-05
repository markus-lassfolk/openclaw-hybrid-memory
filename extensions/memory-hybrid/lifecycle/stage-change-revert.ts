/**
 * Lifecycle: detect "revert change N" in user messages and execute change-feed revert.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

import { capturePluginError } from "../services/error-reporter.js";
import { applyPrependBudget } from "../services/prepend-budget.js";
import {
  buildChangeRevertContext,
  revertChangeByOrdinal,
} from "../services/change-feed-revert.js";
import { withWorkshopDefaults } from "../services/workshop-service.js";
import { withHookResolutionApi } from "./hook-resolution-api.js";
import type { LifecycleContext, SessionState } from "./types.js";

const REVERT_CHANGE_PATTERN = /\brevert\s+change\s+#?(\d+)\b/i;

function extractUserContent(event: unknown): string | undefined {
  const e = event as {
    prompt?: string;
    messages?: Array<{ role?: string; content?: unknown }>;
  };
  if (typeof e.prompt === "string" && e.prompt.trim().length > 0) return e.prompt;
  if (Array.isArray(e.messages)) {
    const userMsgs = e.messages.filter((m) => m && typeof m === "object" && m.role === "user");
    const lastUser = userMsgs[userMsgs.length - 1];
    if (lastUser && typeof lastUser.content === "string") return lastUser.content;
  }
  return undefined;
}

export function registerChangeRevertHandler(
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): void {
  if (!ctx.changeFeed || ctx.cfg.liveChangeFeed?.enabled === false) return;

  const { resolveSessionKey } = sessionState;

  api.on("before_agent_start", async (event: unknown, hookCtx: unknown) => {
    const rApi = withHookResolutionApi(api, hookCtx);
    const sessionKey = resolveSessionKey(event, rApi) ?? ctx.currentAgentIdRef.value ?? "default";
    const userContent = extractUserContent(event);
    if (!userContent) return undefined;

    const match = userContent.match(REVERT_CHANGE_PATTERN);
    if (!match) return undefined;

    const ordinal = Number(match[1]);
    if (!Number.isFinite(ordinal) || ordinal < 1) return undefined;

    try {
      const revertCtx = buildChangeRevertContext({
        changeFeed: ctx.changeFeed!,
        cfg: ctx.cfg,
        sessionKey,
        sessionState,
        workshopCtx: withWorkshopDefaults({
          cfg: ctx.cfg,
          factsDb: ctx.factsDb,
          proposalsDb: null,
          crystallizationStore: null,
          toolProposalStore: null,
          resolvedSqlitePath: ctx.resolvedSqlitePath,
          changeFeed: ctx.changeFeed,
          api: rApi,
          sessionKey,
        }),
      });
      const result = revertChangeByOrdinal(revertCtx, ordinal, sessionKey);
      const block = result.ok
        ? `<memory-change-revert>\n${result.message}\n</memory-change-revert>`
        : `<memory-change-revert error="true">\nCould not revert change #${ordinal}: ${result.error}\n</memory-change-revert>`;
      const prepend = applyPrependBudget(ctx.prependBudgetRef, `\n${block}\n`);
      if (!prepend) return undefined;
      api.logger.info?.(
        `memory-hybrid: change revert via user message for session ${sessionKey} (#${ordinal}, ok=${result.ok})`,
      );
      return { prependContext: prepend };
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "change-revert-user-message",
        subsystem: "change-feed",
        severity: "info",
      });
    }
    return undefined;
  });
}
