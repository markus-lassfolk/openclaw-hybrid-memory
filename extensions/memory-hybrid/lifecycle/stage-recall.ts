/**
 * Lifecycle stage: Recall (Phase 2.3).
 * Owns the interactive recall path for chat turns.
 * Runs the bounded recall pipeline: degradation check, FTS+vector, ambient, directives,
 * entity lookup, scoring. Returns either degraded/empty prependContext or RecallResult for injection.
 * Config: autoRecall.enabled. Stage wall-clock: INTERACTIVE_RECALL_STAGE_TIMEOUT_MS (abort).
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import {
  logSlowBeforeAgentStartIfNeeded,
  resolveBeforeAgentStartStageTimeoutMs,
} from "../services/before-agent-start-budget.js";
import { capturePluginError } from "../services/error-reporter.js";
import { INTERACTIVE_RECALL_STAGE_TIMEOUT_MS } from "../services/retrieval-mode-policy.js";
import { isRecallContextSuperseded } from "../utils/registration-superseded.js";
import { buildDegradedFtsHotRecallStage } from "./stage-recall/degraded-recall.js";
import { runRecall } from "./stage-recall/run-recall.js";
import type { LifecycleContext, RecallStageResult, SessionState } from "./types.js";

const RECALL_STAGE_TIMEOUT_MS = INTERACTIVE_RECALL_STAGE_TIMEOUT_MS;

export async function runRecallStage(
  event: unknown,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): Promise<RecallStageResult | null> {
  if (isRecallContextSuperseded(ctx)) {
    return { kind: "empty", prependContext: undefined };
  }
  const stageTimeoutMs = resolveBeforeAgentStartStageTimeoutMs(ctx.beforeAgentStartTurnRef, RECALL_STAGE_TIMEOUT_MS);
  const ac = new AbortController();
  const { signal } = ac;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let recallSettled = false;
  try {
    const recallPromise = runRecall(event, api, ctx, sessionState, signal).then((result) => {
      recallSettled = true;
      return result;
    });
    const result = await Promise.race([
      recallPromise,
      new Promise<RecallStageResult | null>((resolve) => {
        timer = setTimeout(() => {
          ac.abort();
          if (isRecallContextSuperseded(ctx)) {
            resolve({ kind: "empty", prependContext: undefined });
            return;
          }
          void buildDegradedFtsHotRecallStage(event, api, ctx, sessionState, "timeout").then(
            (degraded) => {
              if (!recallSettled) resolve(degraded);
            },
            (err) => {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                operation: "recall-timeout-fallback",
                severity: "warning",
                subsystem: "stage-recall",
              });
              if (!recallSettled) resolve({ kind: "empty", prependContext: undefined });
            },
          );
        }, stageTimeoutMs);
      }),
    ]);
    logSlowBeforeAgentStartIfNeeded(api.logger, ctx.beforeAgentStartTurnRef, "recall");
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
