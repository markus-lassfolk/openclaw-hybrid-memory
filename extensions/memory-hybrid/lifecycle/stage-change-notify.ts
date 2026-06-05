/**
 * Lifecycle: inject live change notices into agent prepend context.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

import { applyPrependBudget } from "../services/prepend-budget.js";
import { capturePluginError } from "../services/error-reporter.js";
import { shouldNotifyChangeInChat } from "../services/change-feed-emit.js";
import type { ChangeEvent } from "../services/change-feed.js";
import { estimateTokens } from "../utils/text.js";
import { withHookResolutionApi } from "./hook-resolution-api.js";
import type { LifecycleContext, SessionState } from "./types.js";

const CHANGE_NOTICE_INSTRUCTION =
  "Briefly inform the user about these system changes in natural language (do not dump XML). Offer revert for persistent changes.";

function trimEventsToBudget(events: ChangeEvent[], maxEvents: number, budgetTokens: number): ChangeEvent[] {
  const selected = events.slice(0, maxEvents);
  const lines: string[] = [];
  const kept: ChangeEvent[] = [];
  for (const ev of selected) {
    const line = formatChangeLine(ev);
    const candidate = [...lines, line].join("\n");
    if (estimateTokens(candidate) > budgetTokens && kept.length > 0) break;
    lines.push(line);
    kept.push(ev);
  }
  return kept;
}

function formatChangeLine(ev: ChangeEvent): string {
  const tierLabel = ev.tier === "session" ? "session" : "persistent";
  const revertHint =
    ev.rollbackAvailable && ev.status === "active" ? ' (revert: "revert change ' + ev.ordinal + '")' : "";
  return `#${ev.ordinal} [${tierLabel}] ${ev.title}${revertHint}`;
}

export function buildChangeNoticeBlock(events: ChangeEvent[]): string {
  if (events.length === 0) return "";
  const lines = events.map(formatChangeLine);
  return [
    "<memory-change-notice>",
    CHANGE_NOTICE_INSTRUCTION,
    "Recent system changes:",
    ...lines,
    'Active persistent changes can be reverted with "revert change N" or via memory_workshop.',
    "</memory-change-notice>",
  ].join("\n");
}

export function registerChangeNotifyHandler(
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): void {
  const changeFeed = ctx.changeFeed;
  if (!changeFeed || ctx.cfg.liveChangeFeed?.enabled === false) return;
  if (ctx.cfg.liveChangeFeed?.notifyInChat === false) return;

  const { resolveSessionKey, changeNotifyStateMap } = sessionState;
  const lcf = ctx.cfg.liveChangeFeed;

  api.on("before_agent_start", async (event: unknown, hookCtx: unknown) => {
    const rApi = withHookResolutionApi(api, hookCtx);
    const sessionKey = resolveSessionKey(event, rApi) ?? ctx.currentAgentIdRef.value ?? "default";

    try {
      const notifyState = changeNotifyStateMap.get(sessionKey) ?? { lastNotifiedTimestamp: 0 };
      const since = notifyState.lastNotifiedTimestamp;
      const recent = changeFeed.listRecent({ sessionKey, since, limit: 20 });
      const notifiable = recent
        .filter((ev) => ev.status === "active")
        .filter((ev) => shouldNotifyChangeInChat(ctx.cfg, ev))
        .reverse();

      if (notifiable.length === 0) return undefined;

      const maxEvents = lcf?.maxInChatEventsPerTurn ?? 5;
      const budgetTokens = lcf?.inChatBudgetTokens ?? 150;
      const trimmed = trimEventsToBudget(notifiable, maxEvents, budgetTokens);
      if (trimmed.length === 0) return undefined;

      const block = buildChangeNoticeBlock(trimmed);
      const prepend = applyPrependBudget(ctx.prependBudgetRef, `\n${block}\n`);
      if (!prepend) return undefined;

      const latestTs = Math.max(...trimmed.map((e) => e.timestamp));
      changeNotifyStateMap.set(sessionKey, { lastNotifiedTimestamp: latestTs });
      api.logger.debug?.(
        `memory-hybrid: injected change notice for session ${sessionKey} (${trimmed.length} event(s))`,
      );
      return { prependContext: prepend };
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "change-notify-prepend",
        subsystem: "change-feed",
        severity: "info",
      });
    }
    return undefined;
  });
}
