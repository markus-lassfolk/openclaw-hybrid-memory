import type OpenAI from "openai";
import { chatCompleteWithRetry } from "../../services/chat.js";
import { loadPrompt, fillPrompt } from "../../utils/prompt-loader.js";
import { capturePluginError } from "../../services/error-reporter.js";
import type { EventLog } from "../../backends/event-log.js";
import type { WorkflowStore } from "../../backends/workflow-store.js";
import type { NarrativesDB } from "../../backends/narratives-db.js";

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

function toMs(iso: string): number {
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : Date.now();
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

function normalizeNarrative(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").trim();
}

export async function buildDailyNarrative(params: BuildDailyNarrativeParams): Promise<boolean> {
  const { sessionId, eventLog, workflowStore, narrativesDb, openai, model, logger, fallbackModels } = params;
  if (!eventLog || !narrativesDb) return false;

  const events = eventLog.getBySession(sessionId, MAX_EVENTS_FOR_PROMPT);
  if (events.length < 2) return false;

  const workflows = workflowStore ? workflowStore.list({ sessionId, limit: MAX_WORKFLOWS_FOR_PROMPT }) : [];
  const periodStart = toMs(events[0].timestamp);
  const periodEnd = toMs(events[events.length - 1].timestamp);

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
    period_start: new Date(periodStart).toISOString(),
    period_end: new Date(periodEnd).toISOString(),
    event_count: String(events.length),
    workflow_count: String(workflows.length),
    events: eventsBlock || "none",
    workflows: workflowsBlock || "none",
    max_chars: String(DEFAULT_MAX_NARRATIVE_CHARS),
  });

  try {
    const raw = await chatCompleteWithRetry({
      model,
      content: prompt,
      temperature: 0.1,
      maxTokens: 1200,
      openai,
      fallbackModels: fallbackModels ?? [],
      label: "memory-hybrid: narrative-summary",
      feature: "distill",
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
    logger.info?.(`memory-hybrid: stored session narrative for ${sessionId}`);
    return true;
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "narratives",
      operation: "build-daily-narrative",
      sessionId,
    });
    logger.warn(`memory-hybrid: narrative synthesis failed for ${sessionId}: ${err}`);
    return false;
  }
}
