/**
 * Multilingual fact text enrichment: language detection (franc) + PERSON/ORG extraction (LLM).
 * (#985) Complements existing getKnownEntities / autoLinkEntities — does not replace structured `entity` fields.
 */

import { franc } from "franc";
import type OpenAI from "openai";

import type { EntityMentionLabel } from "../backends/facts-db/entity-layer.js";
import { normalizeEntityKey } from "../backends/facts-db/entity-layer.js";
import { withLLMRetry } from "./chat.js";
import { capturePluginError } from "./error-reporter.js";

const MIN_CHARS = 24;
const MAX_CHARS = 8000;

export type ExtractedMention = {
  label: EntityMentionLabel;
  surfaceText: string;
  normalizedSurface: string;
  startOffset: number;
  endOffset: number;
  confidence: number;
};

/** ISO 639-3 code from franc, or "und" when unknown. */
export function detectFactTextLanguage(text: string): string {
  const t = text.trim();
  if (t.length < 10) return "und";
  const code = franc(t);
  return code === "und" ? "und" : code;
}

type LlmMention = {
  label: string;
  text: string;
  start?: number;
  end?: number;
  normalized?: string;
  confidence?: number;
};

function parseMentionJson(content: string): LlmMention[] {
  const trimmed = content.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const obj = JSON.parse(trimmed.slice(start, end + 1)) as { mentions?: LlmMention[] };
    return Array.isArray(obj.mentions) ? obj.mentions : [];
  } catch {
    return [];
  }
}

function clampOffsets(text: string, surface: string, start: number, end: number): { start: number; end: number } {
  const len = text.length;
  let s = Math.max(0, Math.min(start, len));
  let e = Math.max(0, Math.min(end, len));
  if (e < s) [s, e] = [e, s];
  const slice = text.slice(s, e);
  if (slice === surface) return { start: s, end: e };
  const idxFromStart = text.indexOf(surface, s);
  if (idxFromStart >= 0) return { start: idxFromStart, end: idxFromStart + surface.length };
  const idxGlobal = text.indexOf(surface);
  if (idxGlobal >= 0) return { start: idxGlobal, end: idxGlobal + surface.length };
  return { start: s, end: e };
}

/**
 * Extract PERSON and ORG spans using a cheap LLM call. Skips when text too short or API fails.
 * `detectedLang` is ISO 639-3 from franc, passed to the model for multilingual context.
 */
export async function extractEntityMentionsWithLlm(
  text: string,
  openai: OpenAI,
  model: string,
): Promise<{ mentions: ExtractedMention[]; detectedLang: string }> {
  const detectedLang = detectFactTextLanguage(text);
  const trimmed = text.trim();
  if (trimmed.length < MIN_CHARS) {
    return { mentions: [], detectedLang };
  }
  const body = trimmed.length > MAX_CHARS ? `${trimmed.slice(0, MAX_CHARS)}\n…` : trimmed;

  const prompt = `You extract named entities from user memory facts. The text may be in any language; the primary language detected is ISO 639-3: "${detectedLang}" (use "und" if unknown).

Return ONLY valid JSON (no markdown, no commentary) with this shape:
{"mentions":[{"label":"PERSON"|"ORG","text":"exact substring from the input","start":0,"end":10,"normalized":"optional canonical form in original language","confidence":0.0-1.0}]}

Rules:
- label must be only PERSON or ORG.
- text must be copied exactly from the input (same Unicode characters).
- start/end are UTF-16 code unit offsets into the INPUT string below (0-based, end exclusive).
- Do not invent entities; skip if unsure.
- Do not merge different people; keep each surface mention separate.
- For organizations, prefer the full surface form as written (company names, institutions).

INPUT:
${body}`;

  try {
    const resp = await withLLMRetry(
      () =>
        openai.chat.completions.create({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: 1200,
        }),
      { maxRetries: 2 },
    );
    const content = (resp.choices[0]?.message?.content ?? "").trim();
    const raw = parseMentionJson(content);
    const mentions: ExtractedMention[] = [];

    for (const m of raw) {
      const lab = String(m.label ?? "").toUpperCase();
      if (lab !== "PERSON" && lab !== "ORG") continue;
      const surface = String(m.text ?? "").trim();
      if (surface.length < 2) continue;

      const start = typeof m.start === "number" ? m.start : 0;
      const end = typeof m.end === "number" ? m.end : start + surface.length;
      const { start: ss, end: ee } = clampOffsets(trimmed, surface, start, end);
      const slice = trimmed.slice(ss, ee);
      const surfaceText = slice === surface ? surface : slice || surface;
      const conf = typeof m.confidence === "number" && m.confidence >= 0 && m.confidence <= 1 ? m.confidence : 0.75;
      const norm = m.normalized?.trim() ? m.normalized.trim() : surfaceText;
      mentions.push({
        label: lab as EntityMentionLabel,
        surfaceText,
        normalizedSurface: normalizeEntityKey(norm) || norm.toLowerCase(),
        startOffset: ss,
        endOffset: ee,
        confidence: conf,
      });
    }

    return { mentions, detectedLang };
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "entity-enrichment-llm",
      subsystem: "openai",
      model,
    });
    return { mentions: [], detectedLang };
  }
}
