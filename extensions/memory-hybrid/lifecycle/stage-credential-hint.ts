/**
 * Lifecycle: credential hint injection (Phase 2.3).
 * Reads credentials-pending.json and injects hint on before_agent_start when enabled.
 */

import { readFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { capturePluginError } from "../services/error-reporter.js";
import { applyPrependBudget } from "../services/prepend-budget.js";
import { runOptionalBeforeAgentStartStage } from "../services/before-agent-start-budget.js";
import { sanitizePromptInjection } from "../services/skill-prompt-injection.js";
import { withHookResolutionApi } from "./hook-resolution-api.js";
import { resolveSessionKeyFromHookEvent } from "./session-state.js";
import type { LifecycleContext } from "./types.js";

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 min

/**
 * Per-session pending-credential-hint file path. Hashed rather than embedding the raw session
 * key so arbitrary session key content (path separators, `..`, etc.) can't escape `stateDir` or
 * collide across sessions that happen to share a filesystem-unsafe substring.
 */
export function pendingCredentialPath(stateDir: string, sessionKey: string): string {
  const digest = createHash("sha256").update(sessionKey).digest("hex").slice(0, 32);
  return join(stateDir, `credentials-pending-${digest}.json`);
}

export function registerCredentialHint(api: ClawdbotPluginApi, ctx: LifecycleContext): void {
  if (!ctx.cfg.credentials.enabled || !ctx.cfg.credentials.autoDetect || ctx.cfg.verbosity === "silent") return;

  const stateDir = dirname(ctx.resolvedSqlitePath);

  api.on("before_agent_start", async (event: unknown, hookCtx: unknown) =>
    runOptionalBeforeAgentStartStage(ctx.beforeAgentStartTurnRef, "credential-hint", api.logger, async () => {
    const rApi = withHookResolutionApi(api, hookCtx);
    // Must match the writer's fallback chain exactly (stage-capture/run-capture.ts's
    // `resolveSessionKey(event, api) ?? ctx.currentAgentIdRef.value ?? "default"`) — otherwise a
    // turn where the event/context carries no resolvable session id but currentAgentIdRef is set
    // (routine after stage-setup.ts runs) writes under hash(agentId) but reads under
    // hash("default"), silently orphaning the pending-credential-hint file.
    const sessionKey = resolveSessionKeyFromHookEvent(event, rApi) ?? ctx.currentAgentIdRef.value ?? "default";
    const pendingPath = pendingCredentialPath(stateDir, sessionKey);
    try {
      const raw = (await readFile(pendingPath, "utf-8")).trim();
      if (raw.length === 0) {
        await unlink(pendingPath).catch(() => {});
        return;
      }
      let data: { hints?: string[]; at?: number };
      try {
        data = JSON.parse(raw) as { hints?: string[]; at?: number };
      } catch (parseErr) {
        api.logger?.warn?.(
          `memory-hybrid: credentials-pending.json invalid or truncated JSON (${raw.length} chars), removing: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        );
        await unlink(pendingPath).catch(() => {});
        return;
      }
      const at = typeof data.at === "number" ? data.at : 0;
      if (Date.now() - at > PENDING_TTL_MS) {
        await unlink(pendingPath).catch(() => {});
        return;
      }
      const hints = Array.isArray(data.hints) ? data.hints : [];
      if (hints.length === 0) {
        await unlink(pendingPath).catch(() => {});
        return;
      }
      await unlink(pendingPath).catch(() => {});
      const hintText = hints
        .map((h) => sanitizePromptInjection(String(h)))
        .filter(Boolean)
        .join(", ");
      if (!hintText) return;
      const prepend = applyPrependBudget(
        ctx.prependBudgetRef,
        `\n<credential-hint>\nA credential may have been shared in the previous exchange (${hintText}). Consider asking the user if they want to store it securely with credential_store.\n</credential-hint>\n`,
      );
      if (!prepend) return;
      return { prependContext: prepend };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "credential-hint-read",
          subsystem: "credentials",
        });
      }
      await unlink(pendingPath).catch(() => {});
    }
  }),
  );
}
