/**
 * Lifecycle: auth-failure recall (Phase 2.3).
 * On before_agent_start, detect auth failure in prompt/messages and inject credential facts.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import type { ScopeFilter } from "../types/memory.js";
import { mergeResults, filterByScope } from "../services/merge-results.js";
import { VAULT_POINTER_PREFIX } from "../services/auto-capture.js";
import {
  detectAuthFailure,
  buildCredentialQuery,
  formatCredentialHint,
  DEFAULT_AUTH_FAILURE_PATTERNS,
  type AuthFailurePattern,
} from "../services/auth-failure-detect.js";
import { capturePluginError } from "../services/error-reporter.js";
import type { LifecycleContext, SessionState } from "./types.js";

export function registerAuthFailureRecall(
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): void {
  if (
    !ctx.cfg.autoRecall.enabled ||
    !ctx.cfg.autoRecall.authFailure.enabled ||
    ctx.cfg.verbosity === "silent"
  )
    return;

  const customPatterns: AuthFailurePattern[] = [];
  for (const p of ctx.cfg.autoRecall.authFailure.patterns) {
    try {
      customPatterns.push({
        regex: new RegExp(p, "i"),
        type: "generic" as const,
        hint: p,
      });
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "auth-failure-regex",
        subsystem: "auto-recall",
      });
      api.logger.warn?.(`memory-hybrid: invalid regex pattern "${p}": ${err}`);
    }
  }
  const allPatterns = [...DEFAULT_AUTH_FAILURE_PATTERNS, ...customPatterns];
  const { resolveSessionKey, authFailureRecallsThisSession } = sessionState;
  const currentAgentIdRef = ctx.currentAgentIdRef;

  api.on("before_agent_start", async (event: unknown) => {
    const e = event as { prompt?: string; messages?: unknown[] };
    if (!e.prompt && (!e.messages || !Array.isArray(e.messages))) return;
    const sessionKey = resolveSessionKey(event, api) ?? currentAgentIdRef.value ?? "default";

    try {
      let textToScan = e.prompt || "";
      if (e.messages && Array.isArray(e.messages)) {
        const recentMessages = e.messages.slice(-5);
        for (const msg of recentMessages) {
          if (!msg || typeof msg !== "object") continue;
          const msgObj = msg as Record<string, unknown>;
          const content = msgObj.content;
          if (typeof content === "string") textToScan += "\n" + content;
        }
      }

      const detection = detectAuthFailure(textToScan, allPatterns);
      if (!detection.detected || !detection.target) return;

      const recallKey = `${sessionKey}:${detection.target}`;
      const recallCount = authFailureRecallsThisSession.get(recallKey) || 0;
      const maxRecalls = ctx.cfg.autoRecall.authFailure.maxRecallsPerTarget;
      if (maxRecalls > 0 && recallCount >= maxRecalls) {
        api.logger.debug?.(
          `memory-hybrid: auth failure for ${detection.target} already recalled ${recallCount} times this session, skipping`,
        );
        return;
      }

      const query = buildCredentialQuery(detection);
      if (!query) return;

      api.logger.info?.(
        `memory-hybrid: auth failure detected for ${detection.target} (${detection.hint}), searching for credentials...`,
      );

      const detectedAgentId = currentAgentIdRef.value || ctx.cfg.multiAgent.orchestratorId;
      const scopeFilter: ScopeFilter | undefined =
        detectedAgentId && detectedAgentId !== ctx.cfg.multiAgent.orchestratorId
          ? {
              userId: ctx.cfg.autoRecall.scopeFilter?.userId ?? null,
              agentId: detectedAgentId,
              sessionId: ctx.cfg.autoRecall.scopeFilter?.sessionId ?? null,
            }
          : undefined;

      const ftsResults = ctx.factsDb.search(query, 5, {
        scopeFilter,
        reinforcementBoost: ctx.cfg.distill?.reinforcementBoost ?? 0.1,
        diversityWeight: ctx.cfg.reinforcement?.diversityWeight ?? 1.0,
      });
      const vector = await ctx.embeddings.embed(query);
      let lanceResults = await ctx.vectorDb.search(vector, 5, 0.3);
      lanceResults = filterByScope(lanceResults, (id, opts) => ctx.factsDb.getById(id, opts), scopeFilter);

      const merged = mergeResults(
        ftsResults.map((r) => ({ ...r, backend: "sqlite" as const })),
        lanceResults.map((r) => ({ ...r, backend: "lancedb" as const })),
        5,
        ctx.factsDb,
      );

      const scopeValidatedMerged = scopeFilter
        ? merged.filter((r) => ctx.factsDb.getById(r.entry.id, { scopeFilter }) != null)
        : merged;

      let credentialFacts = scopeValidatedMerged.filter((r) => {
        const fact = r.entry;
        if (fact.category === "technical") return true;
        if (fact.entity?.toLowerCase() === "credentials") return true;
        const tags = fact.tags || [];
        return tags.some((t) =>
          ["credential", "ssh", "token", "api", "auth", "password"].includes(t.toLowerCase()),
        );
      });

      if (!ctx.cfg.autoRecall.authFailure.includeVaultHints) {
        credentialFacts = credentialFacts.filter((r) => {
          const fact = r.entry;
          return (
            !fact.text.includes("stored in secure vault") &&
            (!fact.value || !String(fact.value).startsWith(VAULT_POINTER_PREFIX))
          );
        });
      }

      credentialFacts = credentialFacts.slice(0, 3);

      if (credentialFacts.length === 0) {
        api.logger.info?.(`memory-hybrid: no credential facts found for ${detection.target}`);
        return;
      }

      const hint = formatCredentialHint(
        detection,
        credentialFacts.map((r) => r.entry),
      );
      if (hint) {
        api.logger.info?.(
          `memory-hybrid: injecting ${credentialFacts.length} credential facts for ${detection.target}`,
        );
        authFailureRecallsThisSession.set(recallKey, recallCount + 1);
        return { prependContext: hint + "\n\n" };
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "auth-failure-recall",
        subsystem: "auto-recall",
      });
      api.logger.warn(`memory-hybrid: auth failure recall failed: ${String(err)}`);
    }
  });
}
