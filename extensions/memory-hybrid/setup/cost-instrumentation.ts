/** @module cost-instrumentation — Cost feature labeling for LLM calls (init-databases bootstrap). */
import { getCurrentCostFeature } from "../services/cost-context.js";

/**
 * Infer a human-readable feature label for a chat completion call.
 * Checks AsyncLocalStorage first (precise, opt-in via withCostFeature),
 * then falls back to heuristic scanning of message content.
 */
export function inferFeatureLabel(body: Record<string, unknown>, _model: string): string {
  // Precise label: caller wrapped in withCostFeature("label", () => ...)
  const explicit = getCurrentCostFeature();
  if (explicit) return explicit;

  // Heuristic: scan message content for known feature fingerprints.
  // Patterns are derived from the ACTUAL prompt templates in prompts/*.txt to ensure matches.
  // Support both Chat API (body.messages) and Responses API (body.input) formats.
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  const content = messages
    .map((m: unknown) => String((m as Record<string, unknown>)?.content ?? ""))
    .join(" ")
    .toLowerCase();

  // ── Matches derived from actual prompt templates (prompts/*.txt first lines) ──

  // category-classify.txt / memory-classify.txt: "You are a memory classifier"
  if (content.includes("memory classifier") || content.includes("categorize each fact")) return "auto-classify";
  // category-discovery.txt: "assign a short category label"
  if (content.includes("assign a short category label")) return "auto-classify";

  // query-expansion / HyDE: "hypothetical document"
  if (content.includes("hypothetical document") || content.includes("hypothetical answer")) return "query-expansion";

  // reranking
  if (/\brerank/i.test(content)) return "reranking";

  // reflection.txt: "analyzing a user's interaction history to identify behavioral patterns"
  // reflection-meta.txt: "synthesizing behavioral patterns into higher-level meta-patterns"
  // reflection-rules.txt: "synthesizing behavioral patterns into actionable one-line rules"
  if (
    content.includes("identify behavioral patterns") ||
    content.includes("synthesizing behavioral patterns") ||
    content.includes("interaction history to identify")
  )
    return "reflection";

  // self-correction-analyze.txt: "You are a self-improvement analyst"
  // self-correction-rewrite-tools.txt: "You are an editor for a behavioral instructions file"
  if (
    content.includes("self-improvement analyst") ||
    content.includes("self-correction") ||
    content.includes("behavioral instructions file")
  )
    return "self-correction";

  // reinforcement-analyze.txt: "You are a positive-reinforcement analyst"
  if (content.includes("positive-reinforcement analyst") || content.includes("positive reinforcement analyst"))
    return "reinforcement-extract";

  // analyze-feedback-phrases.txt: "analyzing chat logs to discover how this specific user expresses"
  if (content.includes("implicit") && content.includes("feedback")) return "implicit-feedback";
  if (content.includes("discover how this specific user expresses")) return "implicit-feedback";

  // trajectory-analyze.txt: "You are a trajectory analyst"
  if (content.includes("trajectory analyst")) return "trajectory-analysis";

  // frustration detection: looks for frustration keywords in analysis context
  if (content.includes("frustration") && (content.includes("detect") || content.includes("analys")))
    return "frustration-detection";

  // cross-agent-generalize.txt: "identify which of these lessons are general enough"
  if (content.includes("cross-agent") || content.includes("lessons are general enough")) return "cross-agent-learning";

  // tool effectiveness
  if (content.includes("tool effectiveness") || content.includes("tool scoring")) return "tool-effectiveness";

  // distill-sessions.txt: "You are a fact extraction agent"
  // ingest-files.txt: also "You are a fact extraction agent"
  if (content.includes("fact extraction agent")) return "distill";

  // passive-observer.txt: "extracting facts, preferences, decisions"
  if (content.includes("extracting facts, preferences, decisions")) return "distill";

  // language keywords
  if (content.includes("language") && content.includes("keyword")) return "language-keywords";

  // consolidate.txt: "You are a memory consolidator"
  if (content.includes("memory consolidator") || content.includes("merge the following facts")) return "consolidation";

  // generate-proposals.txt: "generating persona file update proposals"
  if (
    content.includes("persona file update proposals") ||
    (content.includes("persona") && content.includes("proposal"))
  )
    return "persona-proposals";

  // continuous verification
  if (content.includes("continuous") && content.includes("verification")) return "continuous-verification";

  return "unknown";
}
