/**
 * Lifecycle stage: Recall (Phase 2.3).
 * Owns the interactive recall path for chat turns.
 * Runs the bounded recall pipeline: degradation check, FTS+vector, ambient, directives,
 * entity lookup, scoring. Returns either degraded/empty prependContext or RecallResult for injection.
 * Config: autoRecall.enabled. Stage wall-clock: INTERACTIVE_RECALL_STAGE_TIMEOUT_MS (abort).
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { INTERACTIVE_RECALL_STAGE_TIMEOUT_MS } from "../services/retrieval-mode-policy.js";
import { isRecallContextSuperseded } from "../utils/registration-superseded.js";
import type { LifecycleContext, RecallStageResult, SessionState } from "./types.js";
import { runRecall } from "./stage-recall/run-recall.js";

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
  const ac = new AbortController();
  const { signal } = ac;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      runRecall(event, api, ctx, sessionState, signal),
      new Promise<RecallStageResult | null>((resolve) => {
        timer = setTimeout(() => {
          ac.abort();
          if (isRecallContextSuperseded(ctx)) {
            resolve({ kind: "empty", prependContext: undefined });
            return;
          }
          resolve(null);
        }, RECALL_STAGE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
