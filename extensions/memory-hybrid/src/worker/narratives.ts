import type OpenAI from "openai";
import type { EventLog } from "../../backends/event-log.js";
import type { NarrativesDB } from "../../backends/narratives-db.js";
import type { WorkflowStore } from "../../backends/workflow-store.js";
import { chatCompleteWithRetry, isAbortOrTransientLlmError } from "../../services/chat.js";
import { capturePluginError } from "../../services/error-reporter.js";
import { getSessionLogFileSuffix, NARRATIVE_CHAT_TIMEOUT_MS } from "../../utils/constants.js";
import { fillPrompt, loadPrompt } from "../../utils/prompt-loader.js";

/** Session transcript basename for `sessionId` (suffix from OPENCLAW_SESSION_LOG_SUFFIX, default .jsonl). */
export function sessionTranscriptFilename(sessionId: string): string {
  return `${sessionId}${getSessionLogFileSuffix()}`;
}

const MAX_EVENTS_FOR_PROMPT = 80;
const MAX_WORKFLOWS_FOR_PROMPT = 20;
const MAX_BLOCK_CHARS = 6000;
const DEFAULT_MAX_NARRATIVE_CHARS = 4096;

export interface BuildDailyNarrativeParams {
  sessionId: string;
  eventLog: EventLog | null;
  workflowStore: WorkflowStore | null;
  narrativesDb: NarrativesDB | null;
  openai: OpenAI;
  model: string;
  logger: { info?: (msg: string) => void; warn: (msg: string) => void };
  fallbackModels?: string[];
}

function toSec(iso: string): number {
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? Math.floor(ts / 1000) : Math.floor(Date.now() / 1000);
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeNarrative(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").trim();
}

export async function buildDailyNarrative(params: BuildDailyNarrativeParams): Promise<boolean> {
  const { sessionId, eventLog, workflowStore, narrativesDb, openai, model, logger, fallbackModels } = params;
  if (!eventLog || !narrativesDb) return false;
  if (!eventLog.isOpen()) return false; // session already disposed

  try {
    const events = eventLog.getBySession(sessionId, MAX_EVENTS_FOR_PROMPT);
    if (events.length < 2) return false;

    const workflows = workflowStore ? workflowStore.list({ sessionId, limit: MAX_WORKFLOWS_FOR_PROMPT }) : [];
    const periodStart = toSec(events[0].timestamp);
    const periodEnd = toSec(events[events.length - 1].timestamp);

    const eventsBlock = clip(
      events
        .map((e) => {
          const content = (() => {
            if (e.eventType === "action_taken" && typeof e.content.action === "string") {
              return `action=${e.content.action}`;
            }
            if (e.eventType === "decision_made" && typeof e.content.decision === "string") {
              return `decision=${e.content.decision}`;
            }
            if (typeof e.content.text === "string") return `text=${e.content.text}`;
            return "content=see_event";
          })();
          const entities = e.entities && e.entities.length > 0 ? ` entities=${e.entities.join(",")}` : "";
          return `[${e.timestamp}] id=${e.id} type=${e.eventType} ${content}${entities}`;
        })
        .join("\n"),
      MAX_BLOCK_CHARS,
    );

    const workflowsBlock = clip(
      workflows
        .map(
          (w) =>
            `[${w.createdAt}] tools=${w.toolSequence.join(" -> ") || "none"} outcome=${w.outcome} duration_ms=${w.durationMs}`,
        )
        .join("\n"),
      MAX_BLOCK_CHARS,
    );

    const prompt = fillPrompt(loadPrompt("narrative-summary"), {
      session_id: sessionId,
      period_start: new Date(periodStart * 1000).toISOString(),
      period_end: new Date(periodEnd * 1000).toISOString(),
      event_count: String(events.length),
      workflow_count: String(workflows.length),
      events: eventsBlock || "none",
      workflows: workflowsBlock || "none",
      max_chars: String(DEFAULT_MAX_NARRATIVE_CHARS),
    });

    const raw = await chatCompleteWithRetry({
      model,
      content: prompt,
      temperature: 0.1,
      maxTokens: 1200,
      openai,
      fallbackModels: fallbackModels ?? [],
      label: "memory-hybrid: narrative-summary",
      feature: "distill",
      timeoutMs: NARRATIVE_CHAT_TIMEOUT_MS,
    });
    const normalized = normalizeNarrative(raw);
    if (!normalized || normalized === "NO_NARRATIVE") return false;
    narrativesDb.store({
      sessionId,
      periodStart,
      periodEnd,
      tag: "session",
      narrativeText: clip(normalized, DEFAULT_MAX_NARRATIVE_CHARS),
    });
    // Keep narrative storage bounded.
    narrativesDb.pruneOlderThan(30);
    logger.info?.(
      `memory-hybrid: stored session narrative for ${sessionId} (transcript file: ${sessionTranscriptFilename(sessionId)})`,
    );
    return true;
  } catch (err) {
    const transient = isAbortOrTransientLlmError(err);
    if (!transient) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "narratives",
        operation: "build-daily-narrative",
        sessionId,
      });
    }
    const detail = err instanceof Error ? err.message : String(err);
    if (transient) {
      logger.info?.(`memory-hybrid: narrative skipped (LLM unavailable or aborted) for ${sessionId}: ${detail}`);
    } else {
      logger.warn(`memory-hybrid: narrative build failed for ${sessionId}: ${err}`);
    }
    return false;
  }
}
