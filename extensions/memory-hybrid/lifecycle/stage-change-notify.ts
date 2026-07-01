/**
 * Lifecycle: inject live change notices into agent prepend context.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

import { applyPrependBudget } from "../services/prepend-budget.js";
import { runOptionalBeforeAgentStartStage } from "../services/before-agent-start-budget.js";
import { capturePluginError } from "../services/error-reporter.js";
import { BROADCAST_CHANGE_SESSION_KEY, shouldNotifyChangeInChat } from "../services/change-feed-emit.js";
import type { ChangeEvent } from "../services/change-feed.js";
import { estimateTokens } from "../utils/text.js";
import { withHookResolutionApi } from "./hook-resolution-api.js";
import type { LifecycleContext, SessionState } from "./types.js";

const CHANGE_NOTICE_INSTRUCTION =
  "Briefly inform the user about these system changes in natural language (do not dump XML). Offer revert for persistent changes.";

const CHANGE_COLLECT_LIMIT = 100;

function truncateLineForTokenBudget(line: string, budgetTokens: number): string {
  if (estimateTokens(line) <= budgetTokens) return line;
  let end = line.length;
  while (end > 20) {
    const candidate = `${line.slice(0, end)}…`;
    if (estimateTokens(candidate) <= budgetTokens) return candidate;
    end = Math.floor(end * 0.85);
  }
  return line.slice(0, Math.min(40, line.length));
}

function truncateEventTitleForDisplay(ev: ChangeEvent, displayOrdinal: number, budgetTokens: number): ChangeEvent {
  const line = formatChangeLine(ev, displayOrdinal);
  if (estimateTokens(line) <= budgetTokens) return ev;
  const truncatedLine = truncateLineForTokenBudget(line, budgetTokens);
  const prefix = `#${displayOrdinal} [`;
  const scopeEnd = truncatedLine.indexOf("] ");
  if (scopeEnd < 0) return ev;
  const revertIdx = truncatedLine.indexOf(' (revert: "revert change');
  const titlePart = revertIdx >= 0 ? truncatedLine.slice(scopeEnd + 2, revertIdx) : truncatedLine.slice(scopeEnd + 2);
  const trimmedTitle = titlePart.endsWith("…") ? titlePart.slice(0, -1) : titlePart;
  return { ...ev, title: trimmedTitle };
}

export function trimEventsToBudget(events: ChangeEvent[], maxEvents: number, budgetTokens: number): ChangeEvent[] {
  const selected = events.slice(0, maxEvents);
  const lines: string[] = [];
  const kept: ChangeEvent[] = [];
  for (let i = 0; i < selected.length; i++) {
    const ev = selected[i]!;
    const displayOrdinal = kept.length + 1;
    const line = formatChangeLine(ev, displayOrdinal);
    const candidate = [...lines, line].join("\n");
    if (estimateTokens(candidate) > budgetTokens) {
      if (kept.length > 0) break;
      const truncatedEvent = truncateEventTitleForDisplay(ev, displayOrdinal, budgetTokens);
      kept.push(truncatedEvent);
      break;
    }
    lines.push(line);
    kept.push(ev);
  }
  return kept;
}

function formatChangeLine(ev: ChangeEvent, displayOrdinal: number): string {
  const scope = ev.sessionKey === BROADCAST_CHANGE_SESSION_KEY ? "system" : "session";
  const tierLabel = ev.tier === "session" ? "session" : "persistent";
  const revertHint =
    ev.rollbackAvailable && ev.status === "active" ? ' (revert: "revert change ' + displayOrdinal + '")' : "";
  return `#${displayOrdinal} [${scope}/${tierLabel}] ${ev.title}${revertHint}`;
}

export function buildChangeNoticeBlock(events: ChangeEvent[]): string {
  if (events.length === 0) return "";
  const lines = events.map((ev, index) => formatChangeLine(ev, index + 1));
  return [
    "<memory-change-notice>",
    CHANGE_NOTICE_INSTRUCTION,
    "Recent system changes:",
    ...lines,
    'Active persistent changes can be reverted with "revert change N" or via memory_workshop.',
    "</memory-change-notice>",
  ].join("\n");
}

function maxOrdinalForSession(events: ChangeEvent[], sessionKey: string, fallback: number): number {
  const matching = events.filter((ev) => ev.sessionKey === sessionKey);
  if (matching.length === 0) return fallback;
  return Math.max(fallback, ...matching.map((ev) => ev.ordinal));
}

export type PendingChangeCollection = {
  notifiable: ChangeEvent[];
  /** Highest ordinal seen in the pending batch (including muted events). */
  maxSeenOrdinal: number;
};

export function collectPendingChangeEvents(
  changeFeed: NonNullable<LifecycleContext["changeFeed"]>,
  cfg: LifecycleContext["cfg"],
  sessionKey: string,
  sinceOrdinal: number,
): PendingChangeCollection {
  const pending = changeFeed.listRecent({ sessionKey, sinceOrdinal, limit: CHANGE_COLLECT_LIMIT, status: "active" });
  const notifiable: ChangeEvent[] = [];
  let maxSeenOrdinal = sinceOrdinal;
  for (const ev of pending) {
    if (ev.ordinal > maxSeenOrdinal) maxSeenOrdinal = ev.ordinal;
    if (shouldNotifyChangeInChat(cfg, ev)) notifiable.push(ev);
  }
  return { notifiable, maxSeenOrdinal };
}

function defaultNotifyState(): { lastNotifiedOrdinal: number; lastNotifiedBroadcastOrdinal: number } {
  return { lastNotifiedOrdinal: 0, lastNotifiedBroadcastOrdinal: 0 };
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

  api.on("before_agent_start", async (event: unknown, hookCtx: unknown) =>
    runOptionalBeforeAgentStartStage(ctx.beforeAgentStartTurnRef, "change-notify", api.logger, async () => {
    const rApi = withHookResolutionApi(api, hookCtx);
    const sessionKey = resolveSessionKey(event, rApi) ?? ctx.currentAgentIdRef.value ?? "default";

    try {
      const notifyState = changeNotifyStateMap.get(sessionKey) ?? defaultNotifyState();

      const sessionPending = collectPendingChangeEvents(
        changeFeed,
        ctx.cfg,
        sessionKey,
        notifyState.lastNotifiedOrdinal,
      );
      const broadcastPending = collectPendingChangeEvents(
        changeFeed,
        ctx.cfg,
        BROADCAST_CHANGE_SESSION_KEY,
        notifyState.lastNotifiedBroadcastOrdinal,
      );

      const notifiable = [...sessionPending.notifiable, ...broadcastPending.notifiable].sort(
        (a, b) => a.timestamp - b.timestamp || a.ordinal - b.ordinal,
      );

      const advanceMutedCursors = (): void => {
        const nextSessionOrdinal = Math.max(notifyState.lastNotifiedOrdinal, sessionPending.maxSeenOrdinal);
        const nextBroadcastOrdinal = Math.max(
          notifyState.lastNotifiedBroadcastOrdinal,
          broadcastPending.maxSeenOrdinal,
        );
        if (
          nextSessionOrdinal > notifyState.lastNotifiedOrdinal ||
          nextBroadcastOrdinal > notifyState.lastNotifiedBroadcastOrdinal
        ) {
          changeNotifyStateMap.set(sessionKey, {
            lastNotifiedOrdinal: nextSessionOrdinal,
            lastNotifiedBroadcastOrdinal: nextBroadcastOrdinal,
          });
        }
      };

      if (notifiable.length === 0) {
        advanceMutedCursors();
        return undefined;
      }

      const maxEvents = lcf?.maxInChatEventsPerTurn ?? 5;
      const budgetTokens = lcf?.inChatBudgetTokens ?? 150;
      const trimmed = trimEventsToBudget(notifiable, maxEvents, budgetTokens);
      if (trimmed.length === 0) {
        advanceMutedCursors();
        return undefined;
      }

      const revertMap = new Map<number, string>();
      trimmed.forEach((ev, index) => {
        revertMap.set(index + 1, ev.id);
      });
      sessionState.displayRevertMap.set(sessionKey, revertMap);

      const block = buildChangeNoticeBlock(trimmed);
      const prepend = applyPrependBudget(ctx.prependBudgetRef, `\n${block}\n`);
      if (!prepend) return undefined;

      changeNotifyStateMap.set(sessionKey, {
        lastNotifiedOrdinal: Math.max(
          maxOrdinalForSession(trimmed, sessionKey, notifyState.lastNotifiedOrdinal),
          sessionPending.maxSeenOrdinal,
        ),
        lastNotifiedBroadcastOrdinal: Math.max(
          maxOrdinalForSession(trimmed, BROADCAST_CHANGE_SESSION_KEY, notifyState.lastNotifiedBroadcastOrdinal),
          broadcastPending.maxSeenOrdinal,
        ),
      });

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
  }),
  );
}
