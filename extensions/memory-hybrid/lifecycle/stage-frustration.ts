/**
 * Lifecycle: frustration detection and tool-hint injection (Phase 2.3).
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { capturePluginError } from "../services/error-reporter.js";
import { buildFrustrationHint, detectFrustration, exportAsImplicitSignals } from "../services/frustration-detector.js";
import { ToolEffectivenessStore, generateToolHint } from "../services/tool-effectiveness.js";
import type { LifecycleContext, SessionState } from "./types.js";

let cachedToolStore: ToolEffectivenessStore | null = null;
let cachedToolStorePath: string | null = null;

function getToolEffectivenessStore(resolvedSqlitePath: string): ToolEffectivenessStore {
  const effectivenessDbPath = resolvedSqlitePath.replace(/(\.[^.]+)?$/, "-tool-effectiveness.db");
  if (!cachedToolStore || cachedToolStorePath !== effectivenessDbPath) {
    cachedToolStore = new ToolEffectivenessStore(effectivenessDbPath);
    cachedToolStorePath = effectivenessDbPath;
  }
  return cachedToolStore;
}

export function registerFrustrationHandlers(
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): void {
  if (ctx.cfg.frustrationDetection?.enabled === false) return;
  const fCfg = ctx.cfg.frustrationDetection;
  const { resolveSessionKey, frustrationStateMap } = sessionState;
  const currentAgentIdRef = ctx.currentAgentIdRef;

  api.on("before_agent_start", async (event: unknown) => {
    const e = event as {
      prompt?: string;
      messages?: Array<{ role?: string; content?: unknown }>;
      agentId?: string;
      session?: { agentId?: string };
    };
    const sessionKey = resolveSessionKey(event, api) ?? currentAgentIdRef.value ?? "default";

    try {
      let userContent: string | undefined;
      if (typeof e.prompt === "string" && e.prompt.trim().length > 0) {
        userContent = e.prompt;
      } else if (Array.isArray(e.messages)) {
        const userMsgs = e.messages.filter((m) => m && typeof m === "object" && m.role === "user");
        const lastUser = userMsgs[userMsgs.length - 1];
        if (lastUser && typeof lastUser.content === "string") userContent = lastUser.content;
      }

      if (!userContent || userContent.trim().length < 5) return;

      const state = frustrationStateMap.get(sessionKey) ?? { level: 0, turns: [] };
      state.turns.push({ role: "user", content: userContent });
      if (state.turns.length > 20) state.turns.splice(0, state.turns.length - 20);

      const frustrationResult = detectFrustration(state.turns, fCfg, state.level);
      state.level = frustrationResult.level;
      frustrationStateMap.set(sessionKey, state);

      const implicitSignals = exportAsImplicitSignals(frustrationResult);
      if (implicitSignals.length > 0) {
        try {
          const rawDb = ctx.factsDb.getRawDb();
          const insert = rawDb.prepare(`
            INSERT OR IGNORE INTO implicit_signals
              (session_file, signal_type, confidence, polarity, user_message, agent_message, preceding_turns, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'frustration')
          `);
          for (const sig of implicitSignals) {
            insert.run(
              sessionKey,
              sig.type,
              sig.confidence,
              sig.polarity,
              userContent.slice(0, 500),
              "",
              state.turns.length,
            );
          }
          api.logger.debug?.(
            `memory-hybrid: frustration exported ${implicitSignals.length} implicit signal(s) for session ${sessionKey}`,
          );
        } catch (fsErr) {
          capturePluginError(fsErr instanceof Error ? fsErr : new Error(String(fsErr)), {
            operation: "frustration-export-implicit-signals",
            subsystem: "frustration",
            severity: "info",
          });
        }
      }

      if (ctx.cfg.verbosity === "silent") return;

      const hint = buildFrustrationHint(frustrationResult, fCfg);
      let toolHintText = "";
      if (ctx.cfg.toolEffectiveness?.enabled !== false && ctx.cfg.toolEffectiveness?.injectHints !== false) {
        try {
          const toolStore = getToolEffectivenessStore(ctx.resolvedSqlitePath);
          const contextLabel = currentAgentIdRef.value ?? "general";
          toolHintText = generateToolHint(toolStore, contextLabel);
        } catch (thErr) {
          capturePluginError(thErr instanceof Error ? thErr : new Error(String(thErr)), {
            operation: "generate-tool-hint",
            subsystem: "tool-effectiveness",
            severity: "info",
          });
        }
      }

      const combinedPrepend = [
        hint ? `\n<frustration-signal>${hint}</frustration-signal>\n` : "",
        toolHintText ? `\n<tool-hint>${toolHintText}</tool-hint>\n` : "",
      ].join("");

      if (combinedPrepend) {
        if (hint) api.logger.debug?.(`memory-hybrid: ${hint}`);
        return { prependContext: combinedPrepend };
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "frustration-detection",
        subsystem: "frustration",
        severity: "info",
      });
    }
    return undefined;
  });
}
