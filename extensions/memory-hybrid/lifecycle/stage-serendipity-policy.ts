/**
 * Serendipity Protocol injection (Issue #2119).
 *
 * On turn start:
 *  - inject a compact policy summary once per session (the current engagement
 *    level + guardrails), and
 *  - on heartbeat / low-activity turns, resurface the single top actionable
 *    deferred-backlog finding (level-gated, cooldown-gated, bounded).
 *
 * Index-only and budget-bounded. It surfaces; the agent acts under the normal
 * approval rules. Distinct from the recall-time `autoRecall.serendipity` slot.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { runOptionalBeforeAgentStartStage } from "../services/before-agent-start-budget.js";
import { capturePluginError } from "../services/error-reporter.js";
import { matchesHeartbeat } from "../services/goal-stewardship-heartbeat.js";
import { applyPrependBudget } from "../services/prepend-budget.js";
import { buildSerendipityPolicySummary } from "../services/serendipity-policy.js";
import { promoteToGoal } from "../services/serendipity-promotion.js";
import { sanitizePromptInjection } from "../services/skill-prompt-injection.js";
import type { SerendipityScopeContext } from "../types/serendipity-types.js";
import { extractLastUserMessageText } from "../utils/extract-last-user-message.js";
import { buildToolScopeFilter } from "../utils/scope-filter.js";
import { resolvedGoalsDirForLifecycle } from "./stage-goal-stewardship.js";
import { resolveSessionKeyFromHookEvent } from "./session-state.js";
import { withHookResolutionApi } from "./hook-resolution-api.js";
import type { LifecycleContext } from "./types.js";

/** Sessions that have already received the one-time policy summary. */
const policyInjectedSessions = new Set<string>();
/** Per-session heartbeat counter used to space out backlog resurfacing. */
const heartbeatCounters = new Map<string, number>();
/** Bound the in-memory maps so long-lived processes don't leak session keys. */
const MAX_TRACKED_SESSIONS = 5000;

function trackSession(key: string): void {
  if (policyInjectedSessions.size > MAX_TRACKED_SESSIONS) policyInjectedSessions.clear();
  if (heartbeatCounters.size > MAX_TRACKED_SESSIONS) heartbeatCounters.clear();
  policyInjectedSessions.add(key);
}

export function registerSerendipityPolicyInjection(api: ClawdbotPluginApi, ctx: LifecycleContext): void {
  const sp = ctx.cfg.serendipityProtocol;
  if (!sp.enabled || !ctx.serendipityStore || ctx.cfg.verbosity === "silent") return;
  if (!sp.injectPolicy && !sp.resurface.enabled) return;

  const store = ctx.serendipityStore;

  api.on("before_agent_start", async (event: unknown, hookCtx: unknown) =>
    runOptionalBeforeAgentStartStage(
      ctx.beforeAgentStartTurnRef,
      "serendipity-policy",
      api.logger,
      async () => {
        try {
          const resolvedApi = withHookResolutionApi(api, hookCtx);
          const sessionKey = resolveSessionKeyFromHookEvent(event, resolvedApi) ?? "default";
          const userText = extractLastUserMessageText(event) ?? "";
          const isHeartbeat = userText ? matchesHeartbeat(userText, ctx.cfg.goalStewardship) : false;

          const scopeFilter = buildToolScopeFilter({}, ctx.currentAgentIdRef.value, ctx.cfg);
          const scope: SerendipityScopeContext = {
            userId: scopeFilter?.userId ?? null,
            agentId: scopeFilter?.agentId ?? null,
            sessionId: scopeFilter?.sessionId ?? null,
          };
          const level = store.resolveLevel(scope, sp.defaultLevel);

          const parts: string[] = [];

          // Policy summary: once per session, on a non-heartbeat turn.
          if (sp.injectPolicy && !isHeartbeat && !policyInjectedSessions.has(sessionKey)) {
            parts.push(buildSerendipityPolicySummary(level, sp.injectionMaxChars));
            trackSession(sessionKey);
          }

          // Backlog resurfacing: on heartbeat turns, level-gated + cooldown-gated.
          if (sp.resurface.enabled && isHeartbeat && level >= sp.resurface.minLevel) {
            const count = (heartbeatCounters.get(sessionKey) ?? 0) + 1;
            heartbeatCounters.set(sessionKey, count);
            if (count >= sp.resurface.cooldownPrompts) {
              const top = store.listActionableDeferred({ level, limit: 1 })[0];
              if (top) {
                heartbeatCounters.set(sessionKey, 0);
                const title = sanitizePromptInjection(top.title).slice(0, sp.resurface.maxChars);
                let promotedNote: string | null = null;
                if (sp.resurface.promote && ctx.cfg.goalStewardship.enabled) {
                  const res = await promoteToGoal(top, {
                    store,
                    cfg: ctx.cfg,
                    goalsDir: resolvedGoalsDirForLifecycle(ctx.cfg),
                    eventLog: ctx.eventLog,
                  });
                  if (res.ok) {
                    promotedNote = `[serendipity backlog] promoted "${title}" to goal ${res.refId?.slice(0, 8)} — track with goal_list.`;
                  }
                }
                if (promotedNote) {
                  parts.push(promotedNote);
                } else {
                  store.markSurfaced(top.id);
                  parts.push(
                    `[serendipity backlog] ${top.findingType}: ${title} — review with serendipity_list backlog:true, act only if in-bounds.`,
                  );
                }
              }
            }
          }

          if (parts.length === 0) return undefined;
          const built = parts.join("\n");
          const prepend = applyPrependBudget(ctx.prependBudgetRef, `${built}\n`);
          if (!prepend?.trim()) return undefined;

          api.logger?.debug?.(`memory-hybrid: serendipity policy injected (level=${level}, heartbeat=${isHeartbeat})`);
          return { prependContext: prepend };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "serendipity-policy-injection",
            subsystem: "serendipity",
          });
          api.logger?.warn?.(`memory-hybrid: serendipity policy injection failed: ${String(err)}`);
          return undefined;
        }
      },
      { timeoutMs: 4000 },
    ),
  );
}
