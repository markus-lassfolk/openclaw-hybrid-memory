/**
 * Insight synthesis (proactive research loop, step A1 — docs/PROACTIVE-RESEARCH.md).
 *
 * Nightly LLM pass over person-signals the living-memory layer already captures — negative-valence
 * facts, mined routines, frustration signals, behavioral patterns, the user's active goals, and the
 * assistant's own durable identity reflections on the relationship — synthesizing at most a couple
 * of evidence-linked `insight` facts about the USER ("recurring friction X deserves attention", or
 * "stated ambition Y has stalled despite being a priority"). Evidence is presented to the model as
 * numbered reference codes and mapped back to real ids on parse; insights citing unknown refs are
 * dropped wholesale, so hallucinated evidence chains are structurally impossible. Insights are
 * ordinary decayable facts: if the pattern stops recurring (or the research loop resolves it), they
 * age out.
 */
import type { DatabaseSync } from "node:sqlite";
import type OpenAI from "openai";
import type { IdentityReflectionStore } from "../backends/identity-reflection-store.js";
import {
  capTimeoutByMaintenanceRunDeadline,
  getMaintenanceRunAbortSignal,
  maintenanceRunDeadlineReached,
} from "../utils/maintenance-run-deadline.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import { chatCompleteWithRetry, LLMRetryError, resolveMaintenanceChatTimeoutMs } from "./chat.js";
import { CostFeature } from "./cost-feature-labels.js";
import { capturePluginError } from "./error-reporter.js";
import { listActiveGoals } from "./goal-registry.js";
import type { Goal } from "./goal-stewardship-types.js";
import { DEFAULT_IDENTITY_REFLECTION_QUESTIONS } from "./identity-reflection.js";

export const INSIGHT_TOPICS = ["wellbeing", "productivity", "growth", "tooling", "relationship", "other"] as const;
export type InsightTopic = (typeof INSIGHT_TOPICS)[number];

export interface InsightSynthesisFactsDb {
  store(entry: {
    text: string;
    category: string;
    importance: number;
    entity: string | null;
    key: string | null;
    value: string | null;
    source: string;
    tags: string[];
    provenanceJson?: string | null;
  }): { id: string };
  getRawDb(): DatabaseSync;
}

export interface InsightSynthesisConfig {
  maxPerRun: number;
  windowDays: number;
  minEvidence: number;
  model: string;
  fallbackModels: string[];
}

export interface InsightSynthesisResult {
  /** Insights the model proposed (post-parse, pre-validation). */
  candidates: number;
  stored: number;
  skippedDedupe: number;
  skippedEvidence: number;
  /** Evidence items offered to the model. */
  evidenceItems: number;
  semanticOutcome: "success" | "failed" | "deferred";
}

interface EvidenceRef {
  kind: "fact" | "signal" | "goal" | "identity";
  id: string;
  /**
   * Frozen display text for goal/identity refs. Facts/signals are re-read live from their tables
   * downstream (research-trigger, `research pick`), which is fine — those rows are stable. Goal
   * state and identity reflections can change by the time the research loop re-reads provenance
   * (a queue fact can sit `in-progress` up to 24h), so their evidence text is captured once, here,
   * at synthesis time — provenance should show what was actually true when the pattern was noticed.
   */
  text?: string;
}

interface ParsedInsight {
  insight: string;
  whyItMatters: string;
  salience: number;
  topic: InsightTopic;
  evidence: string[];
}

/** Slug from the insight head words — the `insight:<slug>` entity is the dedupe/idempotence key. */
export function slugifyInsight(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 6);
  return (words.length > 0 ? words.join("-") : "untitled").slice(0, 48);
}

function oneLine(text: string, maxChars = 200): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed;
}

function daysSince(iso: string | null, nowSec: number): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, (nowSec - ms / 1000) / 86_400);
}

function formatGoalEvidence(g: Goal, nowSec: number): string {
  const ageDays = daysSince(g.createdAt, nowSec);
  const assessedDays = daysSince(g.lastAssessedAt, nowSec);
  const assessed = assessedDays === null ? "never assessed" : `last assessed ${Math.floor(assessedDays)}d ago`;
  const blockers =
    g.currentBlockers.length > 0 ? `; blockers: ${oneLine(g.currentBlockers.join("; "), 120)}` : "; no blockers";
  return `Goal "${oneLine(g.label, 80)}" (priority: ${g.priority}, status: ${g.status}, active ${ageDays === null ? "?" : Math.floor(ageDays)}d, ${assessed}${blockers})`;
}

const GOAL_PRIORITY_RANK: Record<Goal["priority"], number> = { critical: 0, high: 1, normal: 2, low: 3 };

/**
 * Active (non-terminal) goals as evidence — grounds insights in what the user is actually working
 * toward, not just friction (goal-registry is file-based; a read failure must not sink the whole
 * nightly run, so this is best-effort like every other optional evidence source here).
 *
 * `listActiveGoals` returns files in `readdir()` order, which is not a meaningful ranking and isn't
 * guaranteed stable across filesystems — sort by priority then recency before capping to the top 10
 * so which goals get surfaced is deterministic and actually reflects urgency, not directory order.
 */
async function loadActiveGoalsSafely(
  goalsDir: string,
  nowSec: number,
  logger: { warn(m: string): void },
): Promise<Array<{ id: string; text: string }>> {
  try {
    const active = await listActiveGoals(goalsDir);
    active.sort((a, b) => {
      const byPriority = GOAL_PRIORITY_RANK[a.priority] - GOAL_PRIORITY_RANK[b.priority];
      if (byPriority !== 0) return byPriority;
      return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
    });
    return active.slice(0, 10).map((g) => ({ id: g.id, text: formatGoalEvidence(g, nowSec) }));
  } catch (err) {
    logger.warn(`memory-hybrid: insight-synthesis — goal evidence unavailable: ${err}`);
    return [];
  }
}

/**
 * The assistant's own durable self-model (identity-reflection answers "what patterns define good
 * partnership with the user?", "what do I reliably protect?", ...) as evidence — this is the
 * "grounded in who I am and how that relates to who I want to be" half of the loop. Only
 * `durability: "durable"` entries qualify; `"temporary"` ones are the store's own signal that they
 * shouldn't anchor a research decision. Bounded to one entry per fixed question (<=5 total).
 */
function loadDurableIdentityEntries(store: IdentityReflectionStore): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  for (const q of DEFAULT_IDENTITY_REFLECTION_QUESTIONS) {
    const entry = store.getLatestByQuestion(q.key);
    if (entry && entry.durability === "durable") {
      out.push({ id: entry.id, text: `[${entry.questionKey}] ${q.prompt} → ${oneLine(entry.insight, 220)}` });
    }
  }
  return out;
}

function parseInsightResponse(raw: string): { insights: ParsedInsight[]; parseOk: boolean } {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  const json = first !== -1 && last > first ? raw.slice(first, last + 1) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { insights: [], parseOk: false };
  }
  const list = (parsed as { insights?: unknown })?.insights;
  if (!Array.isArray(list)) return { insights: [], parseOk: false };
  const out: ParsedInsight[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const insight = typeof obj.insight === "string" ? obj.insight.trim() : "";
    if (insight.length < 20 || insight.length > 500) continue;
    const whyItMatters = typeof obj.whyItMatters === "string" ? oneLine(obj.whyItMatters, 300) : "";
    const salienceRaw = typeof obj.salience === "number" ? obj.salience : Number.parseFloat(String(obj.salience ?? ""));
    const salience = Number.isFinite(salienceRaw) ? Math.max(0, Math.min(1, salienceRaw)) : 0;
    const topicRaw = typeof obj.topic === "string" ? obj.topic.trim().toLowerCase() : "";
    const topic = (INSIGHT_TOPICS as readonly string[]).includes(topicRaw) ? (topicRaw as InsightTopic) : "other";
    const evidence = Array.isArray(obj.evidence)
      ? [...new Set(obj.evidence.filter((x): x is string => typeof x === "string").map((s) => s.trim().toUpperCase()))]
      : [];
    out.push({ insight, whyItMatters, salience, topic, evidence });
  }
  return { insights: out, parseOk: true };
}

export async function runInsightSynthesis(
  factsDb: InsightSynthesisFactsDb,
  openai: OpenAI,
  cfg: InsightSynthesisConfig,
  opts: {
    dryRun: boolean;
    verbose?: boolean;
    nowSec?: number;
    /** Absolute path to the goal registry dir. Omit/null to skip goal evidence (goal stewardship off). */
    goalsDir?: string | null;
    /** Identity-reflection store. Omit/null to skip identity evidence (identity reflection off). */
    identityStore?: IdentityReflectionStore | null;
  },
  logger: { info(m: string): void; warn(m: string): void },
): Promise<InsightSynthesisResult> {
  const none: InsightSynthesisResult = {
    candidates: 0,
    stored: 0,
    skippedDedupe: 0,
    skippedEvidence: 0,
    evidenceItems: 0,
    semanticOutcome: "success",
  };
  if (maintenanceRunDeadlineReached()) {
    logger.info("memory-hybrid: insight-synthesis — maintenance run deadline reached; deferring");
    return { ...none, semanticOutcome: "deferred" };
  }

  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const windowStart = nowSec - cfg.windowDays * 86_400;
  const db = factsDb.getRawDb();

  // valence/affect_source are not mapped onto MemoryEntry — raw SQL is the supported read path.
  const negValence = db
    .prepare(
      `SELECT id, text, valence FROM facts
        WHERE valence IS NOT NULL AND valence <= -0.2 AND superseded_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?) AND created_at >= ?
        ORDER BY valence ASC, created_at DESC LIMIT 30`,
    )
    .all(nowSec, windowStart) as Array<{ id: string; text: string; valence: number }>;
  const routines = db
    .prepare(
      `SELECT id, text FROM facts
        WHERE category = 'routine' AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC LIMIT 10`,
    )
    .all(nowSec) as Array<{ id: string; text: string }>;
  const patterns = db
    .prepare(
      `SELECT id, text FROM facts
        WHERE category = 'pattern' AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
          AND created_at >= ?
        ORDER BY created_at DESC LIMIT 20`,
    )
    .all(nowSec, windowStart) as Array<{ id: string; text: string }>;
  const signals = db
    .prepare(
      `SELECT id, signal_type, polarity, confidence, user_message, created_at FROM implicit_signals
        WHERE source = 'frustration' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 40`,
    )
    .all(windowStart) as Array<{
    id: number;
    signal_type: string;
    polarity: string | null;
    confidence: number | null;
    user_message: string | null;
    created_at: number;
  }>;
  // Goals/identity are current-state snapshots, not windowed like the four sources above — an
  // active goal or a durable self-model entry is relevant regardless of when it was created.
  const goals = opts.goalsDir ? await loadActiveGoalsSafely(opts.goalsDir, nowSec, logger) : [];
  const identityEntries = opts.identityStore ? loadDurableIdentityEntries(opts.identityStore) : [];

  const evidenceItems =
    negValence.length + routines.length + patterns.length + signals.length + goals.length + identityEntries.length;
  if (evidenceItems < 5) {
    logger.info(`memory-hybrid: insight-synthesis — insufficient evidence (${evidenceItems}/5); skipping`);
    return { ...none, evidenceItems };
  }

  // Numbered reference codes: the model cites F#/S#/G#/I#, the parser maps them back to real ids.
  const refs = new Map<string, EvidenceRef>();
  let factRef = 0;
  const factLine = (id: string, text: string, suffix = ""): string => {
    factRef++;
    const code = `F${factRef}`;
    refs.set(code, { kind: "fact", id });
    return `- ${code}: ${oneLine(text)}${suffix}`;
  };
  const negBlock = negValence.map((f) => factLine(f.id, f.text, ` (valence ${f.valence.toFixed(2)})`)).join("\n");
  const routineBlock = routines.map((f) => factLine(f.id, f.text)).join("\n");
  const patternBlock = patterns.map((f) => factLine(f.id, f.text)).join("\n");
  const signalBlock = signals
    .map((s, i) => {
      const code = `S${i + 1}`;
      refs.set(code, { kind: "signal", id: String(s.id) });
      const when = new Date(s.created_at * 1000).toISOString();
      return `- ${code}: ${s.signal_type} (${s.polarity ?? "negative"}, conf ${(s.confidence ?? 0).toFixed(2)}, ${when}): ${oneLine(s.user_message ?? "", 160)}`;
    })
    .join("\n");
  const goalBlock = goals
    .map((g, i) => {
      const code = `G${i + 1}`;
      refs.set(code, { kind: "goal", id: g.id, text: g.text });
      return `- ${code}: ${g.text}`;
    })
    .join("\n");
  const identityBlock = identityEntries
    .map((e, i) => {
      const code = `I${i + 1}`;
      refs.set(code, { kind: "identity", id: e.id, text: e.text });
      return `- ${code}: ${e.text}`;
    })
    .join("\n");

  const prompt = fillPrompt(loadPrompt("insight-synthesis"), {
    window: String(cfg.windowDays),
    maxPerRun: String(cfg.maxPerRun),
    minEvidence: String(cfg.minEvidence),
    negativeValence: negBlock || "- (none)",
    routines: routineBlock || "- (none)",
    patterns: patternBlock || "- (none)",
    signals: signalBlock || "- (none)",
    goals: goalBlock || "- (none)",
    identity: identityBlock || "- (none)",
  });

  let rawResponse: string;
  try {
    rawResponse = await chatCompleteWithRetry({
      model: cfg.model,
      content: prompt,
      temperature: 0.2,
      maxTokens: 1200,
      openai,
      fallbackModels: cfg.fallbackModels,
      label: "memory-hybrid: insight-synthesis",
      feature: CostFeature.insightSynthesis,
      responseFormat: { type: "json_object" },
      timeoutMs: capTimeoutByMaintenanceRunDeadline(resolveMaintenanceChatTimeoutMs(cfg.model)),
      signal: getMaintenanceRunAbortSignal(),
    });
  } catch (err) {
    logger.warn(`memory-hybrid: insight-synthesis LLM failed: ${err}`);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "insight-synthesis-llm",
      subsystem: "openai",
      retryAttempt: err instanceof LLMRetryError ? err.attemptNumber : 1,
    });
    return { ...none, evidenceItems, semanticOutcome: "failed" };
  }

  const { insights, parseOk } = parseInsightResponse(rawResponse);
  if (!parseOk) {
    logger.warn("memory-hybrid: insight-synthesis — unparseable model response; storing nothing");
    return { ...none, evidenceItems, semanticOutcome: "failed" };
  }

  let stored = 0;
  let skippedDedupe = 0;
  let skippedEvidence = 0;
  const dedupeStmt = db.prepare("SELECT 1 FROM facts WHERE entity = ? AND superseded_at IS NULL LIMIT 1");
  for (const item of insights.slice(0, cfg.maxPerRun)) {
    // Every cited ref must exist in the offered evidence — one unknown ref invalidates the insight.
    if (item.evidence.length < cfg.minEvidence || item.evidence.some((code) => !refs.has(code))) {
      skippedEvidence++;
      continue;
    }
    const slug = slugifyInsight(item.insight);
    const entity = `insight:${slug}`;
    if (dedupeStmt.get(entity)) {
      skippedDedupe++;
      continue;
    }
    if (opts.dryRun) {
      stored++;
      continue;
    }
    const sourceFactIds: string[] = [];
    const sourceEventIds: string[] = [];
    const sourceGoalEvidence: Array<{ id: string; text: string }> = [];
    const sourceIdentityEvidence: Array<{ id: string; text: string }> = [];
    for (const code of item.evidence) {
      const ref = refs.get(code) as EvidenceRef;
      if (ref.kind === "fact") sourceFactIds.push(ref.id);
      else if (ref.kind === "signal") sourceEventIds.push(`implicit_signal:${ref.id}`);
      else if (ref.kind === "goal") sourceGoalEvidence.push({ id: ref.id, text: ref.text ?? "" });
      else sourceIdentityEvidence.push({ id: ref.id, text: ref.text ?? "" });
    }
    const entry = factsDb.store({
      text: item.whyItMatters ? `Insight: ${item.insight} — ${item.whyItMatters}` : `Insight: ${item.insight}`,
      category: "insight",
      importance: 0.5 + 0.4 * item.salience,
      entity,
      key: "concern",
      value: item.topic,
      source: "insight-synthesis",
      tags: ["insight", "auto", "needs-review"],
      provenanceJson: JSON.stringify({
        method: "insight-synthesis",
        salience: item.salience,
        sourceFactIds,
        sourceEventIds,
        sourceGoalEvidence,
        sourceIdentityEvidence,
      }),
    });
    stored++;
    if (opts.verbose) {
      logger.info(
        `memory-hybrid: insight-synthesis — stored ${entry.id} (${item.topic}, salience ${item.salience.toFixed(2)}, evidence ${item.evidence.length})`,
      );
    }
  }

  return {
    candidates: insights.length,
    stored,
    skippedDedupe,
    skippedEvidence,
    evidenceItems,
    semanticOutcome: "success",
  };
}
