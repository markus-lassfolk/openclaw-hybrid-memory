/**
 * Lifecycle stage: Capture (Phase 2.3).
 * On agent_end: frustration assistant capture, event log session_end, clearSessionState,
 * compaction (if enabled), autoCapture, credential hint, tool-call credential capture.
 * Single timeout: 60s.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { withTimeout } from "../utils/timeout.js";
import type { LifecycleContext, SessionState } from "./types.js";
import { runCapture } from "./stage-capture/run-capture.js";

const CAPTURE_STAGE_TIMEOUT_MS = 60_000;

export async function runCaptureStage(
  event: unknown,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): Promise<void> {
  await withTimeout(CAPTURE_STAGE_TIMEOUT_MS, () => runCapture(event, api, ctx, sessionState));
}
