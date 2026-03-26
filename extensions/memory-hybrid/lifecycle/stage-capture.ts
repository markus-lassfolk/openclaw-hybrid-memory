/**
 * Lifecycle stage: Capture (Phase 2.3).
 * On agent_end: frustration assistant capture, event log session_end, clearSessionState,
 * compaction (if enabled), autoCapture, credential hint, tool-call credential capture.
 * Single timeout: 60s.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import type { MemoryCategory } from "../config.js";
import { getCronModelConfig, getDefaultCronModel } from "../config.js";
import { CLI_STORE_IMPORTANCE } from "../utils/constants.js";
import { truncateForStorage } from "../utils/text.js";
import { extractTags } from "../utils/tags.js";
import { extractStructuredFields } from "../services/fact-extraction.js";
import { detectCredentialPatterns } from "../services/auto-capture.js";
import {
  getAutoCaptureExtractionConfidence,
  getAutoCaptureExtractionMethod,
  resolveCaptureProvenance,
} from "../services/capture-provenance.js";
import { classifyMemoryOperation } from "../services/classification.js";
import type { EpisodeOutcome } from "../types/memory.js";
import { extractCredentialsFromToolCalls } from "../services/credential-scanner.js";
import { capturePluginError } from "../services/error-reporter.js";
import { isOllamaCircuitBreakerOpen } from "../services/embeddings.js";
import { withTimeout } from "../utils/timeout.js";
import { runHumanizerScore, formatQualityLoopEntry } from "../services/humanizer-score.js";
import type { LifecycleContext, SessionState } from "./types.js";

const CAPTURE_STAGE_TIMEOUT_MS = 60_000;

/** Outcome indicator patterns for episodic memory auto-capture (#781). */
interface OutcomePattern {
  regex: RegExp;
  label?: string;
}

/** Patterns that indicate a successful outcome. */
const SUCCESS_PATTERNS: OutcomePattern[] = [
  // Git merge / PR merge
  { regex: /✅\s*(?:merged|Merge)/i, label: "merged" },
  { regex: /\b(?:successfully\s+)?(?:merged|Merge)\b/i, label: "merged" },
  // Checkmark / success
  { regex: /✅/i, label: "success" },
  // Explicit success language
  { regex: /\bsucceeded\b/i, label: "succeeded" },
  { regex: /\bcompleted(?:\s+successfully)?\b/i, label: "completed" },
  { regex: /\bfixed\b/i, label: "fixed" },
  { regex: /\bpassed\b/i, label: "passed" },
  { regex: /\bdeployed\b/i, label: "deployed" },
  { regex: /\bresolved\b/i, label: "resolved" },
];

/** Patterns that indicate a failed outcome. */
const FAILURE_PATTERNS: OutcomePattern[] = [
  // Cross mark
  { regex: /❌/i, label: "failed" },
  // Explicit failure
  { regex: /\bfailed\b/i, label: "failed" },
  { regex: /\bfailure\b/i, label: "failure" },
  // Error
  { regex: /\berror\b/i, label: "error" },
  { regex: /\bcrashed\b/i, label: "crashed" },
  { regex: /\bbroke\b/i, label: "broke" },
  { regex: /\bbug\b/i, label: "bug" },
  { regex: /\brejected\b/i, label: "rejected" },
  { regex: /\bdenied\b/i, label: "denied" },
  { regex: /\brevert(?:ed)?\b/i, label: "reverted" },
  { regex: /\brollback\b/i, label: "rollback" },
];

/**
 * Extract text content from the last assistant message in a message array.
 * Returns undefined if no assistant message is found or if the content is empty.
 */
function extractLastAssistantText(messages: unknown[]): string | undefined {
  const assistantMsgs = messages.filter(
    (m) => m && typeof m === "object" && (m as { role?: string }).role === "assistant",
  );
  const lastAssistant = assistantMsgs[assistantMsgs.length - 1] as { content?: unknown } | undefined;
  if (!lastAssistant) return undefined;

  if (typeof lastAssistant.content === "string") {
    return lastAssistant.content;
  }
  if (Array.isArray(lastAssistant.content)) {
    const textBlocks: string[] = [];
    for (const block of lastAssistant.content) {
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        (block as { type?: string }).type === "text" &&
        "text" in block &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        textBlocks.push((block as { text: string }).text);
      }
    }
    if (textBlocks.length > 0) return textBlocks.join(" ");
  }
  return undefined;
}

export async function runCaptureStage(
  event: unknown,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): Promise<void> {
  await withTimeout(CAPTURE_STAGE_TIMEOUT_MS, () => runCapture(event, api, ctx, sessionState));
}

async function runCapture(
  event: unknown,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): Promise<void> {
  const { resolveSessionKey, clearSessionState, frustrationStateMap } = sessionState;
  const sessionKey = resolveSessionKey(event, api) ?? ctx.currentAgentIdRef.value ?? "default";
  const ev = event as { success?: boolean; messages?: unknown[] };
  const messages = ev?.messages ?? [];

  const assistantText = messages.length > 0 ? extractLastAssistantText(messages as unknown[]) : undefined;

  // 1. Frustration: append last assistant message to session turn history
  if (assistantText?.trim()) {
    try {
      const state = frustrationStateMap.get(sessionKey);
      if (state) {
        state.turns.push({ role: "assistant", content: assistantText });
        if (state.turns.length > 20) state.turns.splice(0, state.turns.length - 20);
        frustrationStateMap.set(sessionKey, state);
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "frustration-assistant-capture",
        subsystem: "frustration",
        severity: "info",
      });
    }
  }

  // 2. Humanizer quality-loop scoring (Issue #616 — Phase 1: evaluator only, no rewriting)
  if (ctx.cfg.humanizer?.enabled && assistantText?.trim()) {
    try {
      const humCfg = ctx.cfg.humanizer;
      const result = await runHumanizerScore(assistantText, {
        bin: humCfg.bin,
        minTextLength: humCfg.minTextLength,
        maxTextLength: humCfg.maxTextLength,
      });
      if (result !== null) {
        const entryText = formatQualityLoopEntry(result, {
          modelTag: humCfg.modelTag,
          skillTag: humCfg.skillTag,
        });
        await ctx.factsDb.store({
          text: entryText,
          category: "quality_loop",
          importance: 0.6,
          entity: null,
          key: null,
          value: null,
          source: "humanizer",
          decayClass: "normal",
        });
        api.logger.debug?.(`memory-hybrid: humanizer_score=${result.score.toFixed(2)} stored`);
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "humanizer-score-capture",
        subsystem: "humanizer",
        severity: "info",
      });
      api.logger.debug?.(`memory-hybrid: humanizer scoring skipped: ${String(err)}`);
    }
  }

  // 3. Event log session_end
  if (ctx.eventLog) {
    try {
      ctx.eventLog.append({
        sessionId: sessionKey,
        timestamp: new Date().toISOString(),
        eventType: "action_taken",
        content: { action: "session_end", agentId: ctx.currentAgentIdRef.value },
      });
    } catch {
      // Non-fatal
    }
  }

  // 4. Centralized session state cleanup (Issue #463)
  clearSessionState(sessionKey);
  api.logger.debug?.(`memory-hybrid: cleared all session state for ${sessionKey}`);

  // 5. Compaction on session end
  if (ctx.cfg.memoryTiering.enabled && ctx.cfg.memoryTiering.compactionOnSessionEnd) {
    try {
      const counts = ctx.factsDb.runCompaction({
        inactivePreferenceDays: ctx.cfg.memoryTiering.inactivePreferenceDays,
        hotMaxTokens: ctx.cfg.memoryTiering.hotMaxTokens,
        hotMaxFacts: ctx.cfg.memoryTiering.hotMaxFacts,
      });
      if (counts.hot + counts.warm + counts.cold > 0) {
        api.logger.info?.(`memory-hybrid: tier compaction — hot=${counts.hot} warm=${counts.warm} cold=${counts.cold}`);
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "compaction",
        subsystem: "memory-tiering",
      });
      api.logger.warn(`memory-hybrid: compaction failed: ${err}`);
    }
  }

  // 6. Auto-capture from conversation messages
  if (ctx.cfg.autoCapture && ev.success && messages.length > 0) {
    try {
      const captureProvenance = resolveCaptureProvenance(event, api, sessionKey);
      if (!captureProvenance.shouldAutoCapture) {
        api.logger.debug?.(
          `memory-hybrid: skipped auto-capture for ${captureProvenance.origin} session (${captureProvenance.reason ?? "provenance blocked"})`,
        );
      }

      const candidates: Array<{ role: "user" | "assistant"; text: string; sourceTurn: number }> = [];
      for (let turnIndex = 0; turnIndex < (messages as unknown[]).length; turnIndex++) {
        const msg = (messages as unknown[])[turnIndex];
        if (!msg || typeof msg !== "object") continue;
        const msgObj = msg as Record<string, unknown>;
        const role = msgObj.role;
        if (role !== "user" && role !== "assistant") continue;
        const content = msgObj.content;
        if (typeof content === "string") {
          candidates.push({ role, text: content, sourceTurn: turnIndex + 1 });
          continue;
        }
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block &&
              typeof block === "object" &&
              "type" in block &&
              (block as Record<string, unknown>).type === "text" &&
              "text" in block &&
              typeof (block as Record<string, unknown>).text === "string"
            ) {
              candidates.push({
                role,
                text: (block as Record<string, unknown>).text as string,
                sourceTurn: turnIndex + 1,
              });
            }
          }
        }
      }
      const toCapture = captureProvenance.shouldAutoCapture
        ? candidates.filter((candidate) => candidate.text && ctx.shouldCapture(candidate.text))
        : [];
      if (toCapture.length > 0) {
        let stored = 0;
        for (const candidate of toCapture.slice(0, 3)) {
          let textToStore = candidate.text;
          textToStore = truncateForStorage(textToStore, ctx.cfg.captureMaxChars);
          const category: MemoryCategory = ctx.detectCategory(textToStore);
          const extracted = extractStructuredFields(textToStore, category);
          if (ctx.factsDb.hasDuplicate(textToStore)) continue;
          const summaryThreshold = ctx.cfg.autoRecall.summaryThreshold;
          const summary =
            summaryThreshold > 0 && textToStore.length > summaryThreshold
              ? `${textToStore.slice(0, ctx.cfg.autoRecall.summaryMaxChars).trim()}…`
              : undefined;
          let vector: number[] | undefined;
          if (ctx.cfg.retrieval.strategies.includes("semantic")) {
            try {
              vector = await ctx.embeddings.embed(textToStore);
            } catch (err) {
              const asErr = err instanceof Error ? err : new Error(String(err));
              if (!isOllamaCircuitBreakerOpen(asErr)) {
                capturePluginError(asErr, {
                  operation: "auto-capture-embedding",
                  subsystem: "auto-capture",
                });
              }
              api.logger.warn(`memory-hybrid: auto-capture embedding failed: ${err}`);
            }
          }
          if (ctx.cfg.store.classifyBeforeWrite) {
            let similarFacts = vector ? await ctx.findSimilarByEmbedding(ctx.vectorDb, ctx.factsDb, vector, 3) : [];
            if (similarFacts.length === 0) {
              similarFacts = ctx.factsDb.findSimilarForClassification(textToStore, extracted.entity, extracted.key, 3);
            }
            if (similarFacts.length > 0) {
              try {
                const classification = await classifyMemoryOperation(
                  textToStore,
                  extracted.entity,
                  extracted.key,
                  similarFacts,
                  ctx.openai,
                  ctx.cfg.store.classifyModel ?? getDefaultCronModel(getCronModelConfig(ctx.cfg), "nano"),
                  api.logger,
                );
                if (classification.action === "NOOP") continue;
                if (classification.action === "DELETE" && classification.targetId) {
                  ctx.factsDb.supersede(classification.targetId, null);
                  ctx.aliasDb?.deleteByFactId(classification.targetId);
                  api.logger.info?.(`memory-hybrid: auto-capture DELETE — retracted ${classification.targetId}`);
                  continue;
                }
                if (classification.action === "UPDATE" && classification.targetId) {
                  const oldFact = ctx.factsDb.getById(classification.targetId);
                  if (oldFact) {
                    const finalImportance = Math.max(0.7, oldFact.importance);
                    const walEntryId = await ctx.walWrite(
                      "update",
                      {
                        text: textToStore,
                        category,
                        importance: finalImportance,
                        entity: extracted.entity || oldFact.entity,
                        key: extracted.key || oldFact.key,
                        value: extracted.value || oldFact.value,
                        source: "auto-capture",
                        decayClass: oldFact.decayClass,
                        summary,
                        tags: extractTags(textToStore, extracted.entity),
                        provenanceSession: captureProvenance.sessionId,
                        sourceTurn: candidate.sourceTurn,
                        extractionMethod: getAutoCaptureExtractionMethod(candidate.role, captureProvenance),
                        extractionConfidence: getAutoCaptureExtractionConfidence(candidate.role),
                        vector,
                      },
                      api.logger,
                    );
                    const nowSec = Math.floor(Date.now() / 1000);
                    const newEntry = ctx.factsDb.store({
                      text: textToStore,
                      category,
                      importance: finalImportance,
                      entity: extracted.entity || oldFact.entity,
                      key: extracted.key || oldFact.key,
                      value: extracted.value || oldFact.value,
                      source: "auto-capture",
                      decayClass: oldFact.decayClass,
                      summary,
                      tags: extractTags(textToStore, extracted.entity),
                      validFrom: nowSec,
                      supersedesId: classification.targetId,
                      provenanceSession: captureProvenance.sessionId,
                      sourceTurn: candidate.sourceTurn,
                      extractionMethod: getAutoCaptureExtractionMethod(candidate.role, captureProvenance),
                      extractionConfidence: getAutoCaptureExtractionConfidence(candidate.role),
                    });
                    ctx.factsDb.supersede(classification.targetId, newEntry.id);
                    ctx.aliasDb?.deleteByFactId(classification.targetId);
                    try {
                      if (vector) {
                        ctx.factsDb.setEmbeddingModel(newEntry.id, ctx.embeddings.modelName);
                        if (!(await ctx.vectorDb.hasDuplicate(vector))) {
                          await ctx.vectorDb.store({
                            text: textToStore,
                            vector,
                            importance: finalImportance,
                            category,
                            id: newEntry.id,
                          });
                        }
                      }
                    } catch (vecErr) {
                      capturePluginError(vecErr instanceof Error ? vecErr : new Error(String(vecErr)), {
                        operation: "auto-capture-vector-update",
                        subsystem: "auto-capture",
                      });
                      api.logger.warn(`memory-hybrid: vector capture failed: ${vecErr}`);
                    }
                    await ctx.walRemove(walEntryId, api.logger);
                    api.logger.info?.(
                      `memory-hybrid: auto-capture UPDATE — superseded ${classification.targetId} with ${newEntry.id}`,
                    );
                    stored++;
                    continue;
                  }
                }
              } catch (err) {
                capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                  operation: "auto-capture-classification",
                  subsystem: "auto-capture",
                });
                api.logger.warn(`memory-hybrid: auto-capture classification failed: ${err}`);
              }
            }
          }
          const walEntryId = await ctx.walWrite(
            "store",
            {
              text: textToStore,
              category,
              importance: CLI_STORE_IMPORTANCE,
              entity: extracted.entity,
              key: extracted.key,
              value: extracted.value,
              source: "auto-capture",
              summary,
              tags: extractTags(textToStore, extracted.entity),
              provenanceSession: captureProvenance.sessionId,
              sourceTurn: candidate.sourceTurn,
              extractionMethod: getAutoCaptureExtractionMethod(candidate.role, captureProvenance),
              extractionConfidence: getAutoCaptureExtractionConfidence(candidate.role),
              vector,
            },
            api.logger,
          );
          const storedEntry = ctx.factsDb.store({
            text: textToStore,
            category,
            importance: CLI_STORE_IMPORTANCE,
            entity: extracted.entity,
            key: extracted.key,
            value: extracted.value,
            source: "auto-capture",
            summary,
            tags: extractTags(textToStore, extracted.entity),
            provenanceSession: captureProvenance.sessionId,
            sourceTurn: candidate.sourceTurn,
            extractionMethod: getAutoCaptureExtractionMethod(candidate.role, captureProvenance),
            extractionConfidence: getAutoCaptureExtractionConfidence(candidate.role),
          });
          try {
            if (vector) {
              ctx.factsDb.setEmbeddingModel(storedEntry.id, ctx.embeddings.modelName);
              if (!(await ctx.vectorDb.hasDuplicate(vector))) {
                await ctx.vectorDb.store({
                  text: textToStore,
                  vector,
                  importance: CLI_STORE_IMPORTANCE,
                  category,
                  id: storedEntry.id,
                });
              }
            }
          } catch (vecErr) {
            capturePluginError(vecErr instanceof Error ? vecErr : new Error(String(vecErr)), {
              operation: "auto-capture-vector-store",
              subsystem: "auto-capture",
            });
            api.logger.warn(`memory-hybrid: vector capture failed: ${vecErr}`);
          }
          await ctx.walRemove(walEntryId, api.logger);
          stored++;
        }
        if (stored > 0) api.logger.info(`memory-hybrid: auto-captured ${stored} memories`);
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "auto-capture",
        subsystem: "auto-capture",
      });
      api.logger.warn(`memory-hybrid: capture failed: ${String(err)}`);
    }
  }

  // 6b. Episodic memory auto-capture (#781): scan conversation for outcome-indicating phrases
  // and create episode records. This runs regardless of autoCapture config flag, because
  // capturing outcomes is low-cost and high-value for the episodic history.
  {
    const sessionId = sessionKey;
    const agentId = ctx.currentAgentIdRef.value ?? undefined;
    // Collect all text from the session for scanning
    const sessionTexts: Array<{ text: string; turnIndex: number }> = [];
    for (let turnIndex = 0; turnIndex < (messages as unknown[]).length; turnIndex++) {
      const msg = (messages as unknown[])[turnIndex];
      if (!msg || typeof msg !== "object") continue;
      const msgObj = msg as Record<string, unknown>;
      const content = msgObj.content;
      if (typeof content === "string") {
        sessionTexts.push({ text: content, turnIndex });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === "object" &&
            "text" in block &&
            typeof (block as Record<string, unknown>).text === "string"
          ) {
            sessionTexts.push({ text: (block as Record<string, unknown>).text as string, turnIndex });
          }
        }
      }
    }

    for (const { text } of sessionTexts) {
      let episodeCreated = false;
      // Scan for success indicators
      for (const pattern of SUCCESS_PATTERNS) {
        const match = pattern.regex.exec(text);
        if (match) {
          const eventText = pattern.label ? `Agent reported: ${pattern.label}` : match[0];
          const sinceTimestamp = Math.floor(Date.now() / 1000) - 300; // within last 5 min
          const hasDuplicate = ctx.factsDb.hasRecentEpisodeWithEvent(eventText, sinceTimestamp);
          if (!hasDuplicate) {
            try {
              const episode = ctx.factsDb.recordEpisode({
                event: eventText,
                outcome: "success",
                timestamp: Math.floor(Date.now() / 1000),
                context: text.slice(0, 500),
                sessionId,
                agentId,
                scope: "session",
                scopeTarget: sessionId,
                tags: pattern.label ? [pattern.label] : [],
              });
              api.logger.debug?.(`memory-hybrid: auto-captured success episode: ${episode.id}`);
              episodeCreated = true;
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                operation: "episode-auto-capture-success",
                subsystem: "episodes",
                severity: "info",
              });
            }
          }
          break; // only one episode per message
        }
      }

      // Scan for failure indicators (skip if success episode was already created)
      if (!episodeCreated) {
        for (const pattern of FAILURE_PATTERNS) {
          const match = pattern.regex.exec(text);
          if (match) {
            const eventText = pattern.label ? `Agent reported: ${pattern.label}` : match[0];
            const sinceTimestamp = Math.floor(Date.now() / 1000) - 300;
            const hasDuplicate = ctx.factsDb.hasRecentEpisodeWithEvent(eventText, sinceTimestamp);
            if (!hasDuplicate) {
              try {
                const episode = ctx.factsDb.recordEpisode({
                  event: eventText,
                  outcome: "failure",
                  timestamp: Math.floor(Date.now() / 1000),
                  context: text.slice(0, 500),
                  sessionId,
                  agentId,
                  scope: "session",
                  scopeTarget: sessionId,
                  tags: pattern.label ? [pattern.label] : [],
                  // failures get importance >= 0.8 automatically via recordEpisode
                });
                api.logger.debug?.(`memory-hybrid: auto-captured failure episode: ${episode.id}`);
              } catch (err) {
                capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                  operation: "episode-auto-capture-failure",
                  subsystem: "episodes",
                  severity: "info",
                });
              }
            }
            break;
          }
        }
      }
    }
  }

  // 7. Credential auto-detect: persist hint for next turn
  if (
    ctx.cfg.credentials.enabled &&
    ctx.cfg.credentials.autoDetect &&
    ctx.cfg.verbosity !== "silent" &&
    messages.length > 0
  ) {
    const pendingPath = join(dirname(ctx.resolvedSqlitePath), "credentials-pending.json");
    try {
      const texts: string[] = [];
      for (const msg of messages as unknown[]) {
        if (!msg || typeof msg !== "object") continue;
        const msgObj = msg as Record<string, unknown>;
        const content = msgObj.content;
        if (typeof content === "string") texts.push(content);
        else if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block &&
              typeof block === "object" &&
              "type" in block &&
              (block as Record<string, unknown>).type === "text" &&
              "text" in block
            ) {
              const t = (block as Record<string, unknown>).text;
              if (typeof t === "string") texts.push(t);
            }
          }
        }
      }
      const allText = texts.join("\n");
      const detected = detectCredentialPatterns(allText);
      if (detected.length > 0) {
        await mkdir(dirname(pendingPath), { recursive: true });
        await writeFile(
          pendingPath,
          JSON.stringify({
            hints: detected.map((d) => d.hint),
            at: Date.now(),
          }),
          "utf-8",
        );
        api.logger.info(
          `memory-hybrid: credential patterns detected (${detected.map((d) => d.hint).join(", ")}) — will prompt next turn`,
        );
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "credential-auto-detect",
        subsystem: "credentials",
      });
      api.logger.warn(`memory-hybrid: credential auto-detect failed: ${err}`);
    }
  }

  // 8. Tool-call credential auto-capture
  if (ctx.cfg.credentials.enabled && ctx.cfg.credentials.autoCapture?.toolCalls && messages.length > 0) {
    const logCaptures = ctx.cfg.credentials.autoCapture.logCaptures !== false;
    try {
      for (const msg of messages as unknown[]) {
        if (!msg || typeof msg !== "object") continue;
        const msgObj = msg as Record<string, unknown>;
        if (msgObj.role !== "assistant") continue;
        const toolCalls = msgObj.tool_calls;
        if (!Array.isArray(toolCalls)) continue;
        for (const tc of toolCalls) {
          if (!tc || typeof tc !== "object") continue;
          const tcObj = tc as Record<string, unknown>;
          const fn = tcObj.function as Record<string, unknown> | undefined;
          if (!fn) continue;
          const args = fn.arguments;
          if (typeof args !== "string" || args.length === 0) continue;
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(args);
          } catch (err) {
            capturePluginError(err as Error, {
              operation: "json-parse-tool-args",
              severity: "info",
              subsystem: "lifecycle",
            });
          }
          const argsToScan = Object.values(parsedArgs)
            .filter((v): v is string => typeof v === "string")
            .join(" ");
          const creds = extractCredentialsFromToolCalls(argsToScan || args);
          for (const cred of creds) {
            if (ctx.credentialsDb) {
              const stored = ctx.credentialsDb.storeIfNew({
                service: cred.service,
                type: cred.type,
                value: cred.value,
                url: cred.url,
                notes: cred.notes,
              });
              if (stored && logCaptures) {
                api.logger.info(`memory-hybrid: auto-captured credential for ${cred.service} (${cred.type})`);
              }
            } else {
              const text = `Credential for ${cred.service} (${cred.type})${cred.url ? ` — ${cred.url}` : ""}${cred.notes ? `. ${cred.notes}` : ""}.`;
              const entry = ctx.factsDb.store({
                text,
                category: "technical" as MemoryCategory,
                importance: 0.9,
                entity: "Credentials",
                key: cred.service,
                value: cred.value,
                source: "conversation",
                decayClass: "permanent",
                tags: ["auth", "credential"],
              });
              if (ctx.cfg.retrieval.strategies.includes("semantic")) {
                try {
                  const vector = await ctx.embeddings.embed(text);
                  ctx.factsDb.setEmbeddingModel(entry.id, ctx.embeddings.modelName);
                  if (!(await ctx.vectorDb.hasDuplicate(vector))) {
                    await ctx.vectorDb.store({
                      text,
                      vector,
                      importance: 0.9,
                      category: "technical",
                      id: entry.id,
                    });
                  }
                } catch (err) {
                  const asErr = err instanceof Error ? err : new Error(String(err));
                  if (!isOllamaCircuitBreakerOpen(asErr)) {
                    capturePluginError(asErr, {
                      operation: "tool-call-credential-vector-store",
                      subsystem: "credentials",
                    });
                  }
                  api.logger.warn(`memory-hybrid: vector store for credential fact failed: ${err}`);
                }
              }
              if (logCaptures) {
                api.logger.info(`memory-hybrid: auto-captured credential for ${cred.service} (${cred.type})`);
              }
            }
          }
        }
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "tool-call-credential-auto-capture",
        subsystem: "credentials",
      });
      const errMsg = err instanceof Error ? err.stack || err.message : String(err);
      api.logger.warn(`memory-hybrid: tool-call credential auto-capture failed: ${errMsg}`);
    }
  }
}
