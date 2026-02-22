/**
 * Build .language-keywords.json: detect top languages from memory text samples,
 * then use an LLM with English intents as template to produce natural equivalents
 * (not literal translation): triggers, category/decay keywords, structural
 * trigger phrases, and extraction building blocks. Handles word order, phrasing,
 * and idioms per language.
 */

import type OpenAI from "openai";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ENGLISH_KEYWORDS,
  buildMergedFromTranslations,
  type LanguageKeywordsFile,
  type LanguageExtractionTemplate,
  type KeywordGroup,
  clearKeywordCache,
} from "../utils/language-keywords.js";
import { capturePluginError } from "./error-reporter.js";
import {
  KEYWORD_GROUP_INTENTS,
  STRUCTURAL_TRIGGER_INTENTS,
  EXTRACTION_INTENTS,
} from "./intent-template.js";

const LANG_FILE_NAME = ".language-keywords.json";
const MAX_SAMPLES = 50;
const CHARS_PER_SAMPLE = 400;

const KEYWORD_GROUPS = Object.keys(ENGLISH_KEYWORDS) as KeywordGroup[];

export type BuildLanguageKeywordsResult = {
  ok: true;
  path: string;
  topLanguages: string[];
  languagesAdded: number;
} | { ok: false; error: string };

/**
 * Collect text samples from facts (for language detection).
 */
export function collectSamplesFromFacts(
  facts: Array<{ text: string }>,
  maxSamples: number = MAX_SAMPLES,
  charsPerSample: number = CHARS_PER_SAMPLE,
): string[] {
  const samples: string[] = [];
  const seen = new Set<string>();
  for (const f of facts) {
    const t = (f.text || "").trim();
    if (t.length < 20) continue;
    const key = t.slice(0, 80).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    samples.push(t.slice(0, charsPerSample));
    if (samples.length >= maxSamples) break;
  }
  return samples;
}

/**
 * Ask LLM to detect the 3 most common languages in the samples. Returns ISO 639-1 codes (e.g. en, sv, de).
 */
export async function detectTopLanguages(
  samples: string[],
  openai: OpenAI,
  model: string,
): Promise<string[]> {
  if (samples.length === 0) return [];
  const block = samples
    .slice(0, 30)
    .map((s, i) => `[${i + 1}]\n${s}`)
    .join("\n\n");
  const prompt = `You are a language detector. Below are text samples from user memory/conversation logs.
Identify the 3 most common languages in these samples. Reply with ONLY a JSON array of ISO 639-1 language codes, e.g. ["en","sv","de"].
Do not include any other text. If you see only one or two languages, return 1 or 2 codes. Exclude "en" if it is not clearly present.

Samples:
${block}`;
  try {
    const resp = await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 100,
    });
    const content = (resp.choices[0]?.message?.content ?? "").trim();
    const match = content.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const arr = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.toLowerCase().slice(0, 3))
      .filter((x) => x.length >= 2);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: 'parse-language-codes',
      severity: 'info',
      subsystem: 'language-keywords'
    });
    return [];
  }
}

/**
 * Build the intent-based prompt: English as template of *intents*, not literal strings.
 * Asks for natural equivalents (phrasing, word order, idioms) plus structural trigger phrases
 * and extraction building blocks.
 */
function buildIntentPrompt(langCodes: string[], englishPayload: string): string {
  const intentsBlock = KEYWORD_GROUPS.map(
    (g) => `- ${g}: ${KEYWORD_GROUP_INTENTS[g]}`,
  ).join("\n");
  const structureBlock = Object.entries(STRUCTURAL_TRIGGER_INTENTS)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  const extractionBlock = Object.entries(EXTRACTION_INTENTS)
    .map(([k, v]) => {
      const desc = typeof v === "object" && v !== null && "description" in v ? (v as { description: string }).description : "";
      const rest = typeof v === "object" && v !== null ? Object.entries(v).filter(([key]) => key !== "description").map(([key, val]) => `  ${key}: ${val}`).join("\n") : "";
      return `- ${k}: ${desc}\n${rest}`;
    })
    .join("\n\n");

  return `You are an expert in multilingual memory and natural language. We need natural, intent-based equivalents of the following English keywords and patterns for a memory capture system — NOT literal word-for-word translation. Consider typical word order, phrasing, and idioms in each target language.

TARGET LANGUAGES (ISO 639-1): ${langCodes.join(", ")}

=== INTENTS FOR KEYWORD GROUPS ===
Each group has a purpose. Produce phrases/words that native speakers would use to express the same intent:
${intentsBlock}

=== STRUCTURAL TRIGGER PHRASES ===
We need sentence-level patterns (for trigger detection). Provide natural equivalents for:
${structureBlock}
Output as an array of short phrases or sentence starters (e.g. "ich bevorzuge", "mein X ist", "immer verwenden") that we can match in text.

=== EXTRACTION BUILDING BLOCKS ===
For structured fact extraction we need lists of words/phrases per language to build safe regex. Provide arrays for:
${extractionBlock}

=== ENGLISH SOURCE (for reference) ===
${englishPayload}

=== OUTPUT FORMAT ===
Reply with ONLY valid JSON (no markdown, no explanation). One top-level key per language code. Each language object must contain:

1. All keyword groups (same keys as English): triggers, categoryDecision, categoryPreference, categoryEntity, categoryFact, decayPermanent, decaySession, decayActive. Each value: array of strings (natural equivalents for that intent; can be more or fewer than English).

2. "triggerStructures": array of strings — natural phrases for first-person preference, possessive fact, and always/never rule in this language.

3. "extraction": object with optional keys (only include if you can provide valid arrays):
   - "decision": { "verbs": string[], "connectors": string[] }
   - "choiceOver": { "verbs": string[], "rejectors": string[], "connectors": string[] }
   - "convention": { "always": string[], "never": string[] }
   - "possessive": { "possessiveWords": string[], "isWords": string[] }
   - "preference": { "subject": string[], "verbs": string[] }
   - "nameIntro": { "verbs": string[] }

Example shape (one language):
{"de": {"triggers": ["merken", "bevorzuge", ...], "categoryDecision": [...], ...}, "triggerStructures": ["ich bevorzuge", "mein ... ist", ...], "extraction": {"decision": {"verbs": ["entschied", "wählte"], "connectors": ["weil", "da"]}, ...}}}

Output the JSON now:`;
}

/**
 * Validate and normalize extraction template from LLM.
 */
function normalizeExtraction(raw: unknown): LanguageExtractionTemplate | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const out: LanguageExtractionTemplate = {};
  if (o.decision && typeof o.decision === "object") {
    const d = o.decision as Record<string, unknown>;
    const verbs = Array.isArray(d.verbs) ? d.verbs.filter((x): x is string => typeof x === "string") : [];
    const connectors = Array.isArray(d.connectors) ? d.connectors.filter((x): x is string => typeof x === "string") : [];
    if (verbs.length > 0) out.decision = { verbs, connectors };
  }
  if (o.choiceOver && typeof o.choiceOver === "object") {
    const c = o.choiceOver as Record<string, unknown>;
    const verbs = Array.isArray(c.verbs) ? c.verbs.filter((x): x is string => typeof x === "string") : [];
    const rejectors = Array.isArray(c.rejectors) ? c.rejectors.filter((x): x is string => typeof x === "string") : [];
    const connectors = Array.isArray(c.connectors) ? c.connectors.filter((x): x is string => typeof x === "string") : [];
    if (verbs.length > 0 && rejectors.length > 0) out.choiceOver = { verbs, rejectors, connectors };
  }
  if (o.convention && typeof o.convention === "object") {
    const c = o.convention as Record<string, unknown>;
    const always = Array.isArray(c.always) ? c.always.filter((x): x is string => typeof x === "string") : [];
    const never = Array.isArray(c.never) ? c.never.filter((x): x is string => typeof x === "string") : [];
    if (always.length > 0 || never.length > 0) out.convention = { always, never };
  }
  if (o.possessive && typeof o.possessive === "object") {
    const p = o.possessive as Record<string, unknown>;
    const possessiveWords = Array.isArray(p.possessiveWords) ? p.possessiveWords.filter((x): x is string => typeof x === "string") : [];
    const isWords = Array.isArray(p.isWords) ? p.isWords.filter((x): x is string => typeof x === "string") : [];
    if (possessiveWords.length > 0 && isWords.length > 0) out.possessive = { possessiveWords, isWords };
  }
  if (o.preference && typeof o.preference === "object") {
    const p = o.preference as Record<string, unknown>;
    const subject = Array.isArray(p.subject) ? p.subject.filter((x): x is string => typeof x === "string") : [];
    const verbs = Array.isArray(p.verbs) ? p.verbs.filter((x): x is string => typeof x === "string") : [];
    if (subject.length > 0 && verbs.length > 0) out.preference = { subject, verbs };
  }
  if (o.nameIntro && typeof o.nameIntro === "object") {
    const n = o.nameIntro as Record<string, unknown>;
    const verbs = Array.isArray(n.verbs) ? n.verbs.filter((x): x is string => typeof x === "string") : [];
    if (verbs.length > 0) out.nameIntro = { verbs };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Ask LLM to produce intent-based natural equivalents for each language (keywords,
 * structural trigger phrases, extraction building blocks). Uses English as template of intents.
 */
export async function generateIntentBasedLanguages(
  langCodes: string[],
  openai: OpenAI,
  model: string,
): Promise<{
  translations: Record<string, Record<KeywordGroup, string[]>>;
  triggerStructures: Record<string, string[]>;
  extraction: Record<string, LanguageExtractionTemplate>;
}> {
  const toTranslate = langCodes.filter((c) => c !== "en");
  if (toTranslate.length === 0) {
    return { translations: {}, triggerStructures: {}, extraction: {} };
  }

  const englishPayload = KEYWORD_GROUPS.map(
    (g) => `${g}:\n${(ENGLISH_KEYWORDS[g] as readonly string[]).join("\n")}`,
  ).join("\n---\n");

  const prompt = buildIntentPrompt(toTranslate, englishPayload);

  try {
    const resp = await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 6000,
    });
    const content = (resp.choices[0]?.message?.content ?? "").trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { translations: {}, triggerStructures: {}, extraction: {} };
    }
    const parsed = JSON.parse(jsonMatch[0]) as Record<
      string,
      Record<string, unknown> & { triggerStructures?: string[]; extraction?: unknown }
    >;

    const translations: Record<string, Record<KeywordGroup, string[]>> = {};
    const triggerStructures: Record<string, string[]> = {};
    const extraction: Record<string, LanguageExtractionTemplate> = {};

    for (const lang of toTranslate) {
      const data = parsed[lang];
      if (!data || typeof data !== "object") continue;

      const out: Record<string, string[]> = {};
      for (const g of KEYWORD_GROUPS) {
        const arr = data[g];
        if (Array.isArray(arr)) out[g] = arr.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
      }
      if (Object.keys(out).length > 0) translations[lang] = out as Record<KeywordGroup, string[]>;

      const structures = data.triggerStructures;
      if (Array.isArray(structures)) {
        const list = structures.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
        if (list.length > 0) triggerStructures[lang] = list;
      }

      const ext = normalizeExtraction(data.extraction);
      if (ext) extraction[lang] = ext;
    }

    return { translations, triggerStructures, extraction };
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: 'parse-intent-response',
      severity: 'info',
      subsystem: 'language-keywords'
    });
    return { translations: {}, triggerStructures: {}, extraction: {} };
  }
}

/**
 * Legacy: translate keywords literally (same order as English). Kept for backward compatibility.
 */
export async function translateKeywordsToLanguages(
  langCodes: string[],
  openai: OpenAI,
  model: string,
): Promise<Record<string, Record<KeywordGroup, string[]>>> {
  const toTranslate = langCodes.filter((c) => c !== "en");
  if (toTranslate.length === 0) return {};

  const payload = KEYWORD_GROUPS.map(
    (g) => `${g}:\n${(ENGLISH_KEYWORDS[g] as readonly string[]).join("\n")}`,
  ).join("\n---\n");

  const prompt = `You are a translator for a memory/capture system. Translate the following English keywords and short phrases into the given languages.
Each section is a category name followed by one phrase per line. For each language, output the SAME structure with translated phrases (one per line).
Languages to translate into: ${toTranslate.join(", ")}. Use ISO 639-1 codes as keys.

English keywords:
${payload}

Reply with ONLY valid JSON in this exact shape (no markdown, no explanation):
{"<langCode>": {"triggers": ["...", ...], "categoryDecision": [...], "categoryPreference": [...], "categoryEntity": [...], "categoryFact": [...], "decayPermanent": [...], "decaySession": [...], "decayActive": [...], "correctionSignals": [...]}, ...}
Each key must be one of: triggers, categoryDecision, categoryPreference, categoryEntity, categoryFact, decayPermanent, decaySession, decayActive, correctionSignals.
Each value must be an array of translated strings in the same order as the English list. Translate correctionSignals as natural phrases users say when correcting an AI (e.g. "that was wrong", "try again", "you misunderstood") in the target language.`;

  try {
    const resp = await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 4000,
    });
    const content = (resp.choices[0]?.message?.content ?? "").trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, Record<string, string[]>>;
    const result: Record<string, Record<KeywordGroup, string[]>> = {};
    for (const lang of toTranslate) {
      const data = parsed[lang];
      if (!data || typeof data !== "object") continue;
      const out: Record<string, string[]> = {};
      for (const g of KEYWORD_GROUPS) {
        const arr = data[g];
        if (Array.isArray(arr)) out[g] = arr.filter((x): x is string => typeof x === "string");
      }
      if (Object.keys(out).length > 0) result[lang] = out as Record<KeywordGroup, string[]>;
    }
    return result;
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: 'parse-translation-response',
      severity: 'info',
      subsystem: 'language-keywords'
    });
    return {};
  }
}

/**
 * Run full build: sample facts -> detect languages -> intent-based generation -> write file (v2).
 */
export async function runBuildLanguageKeywords(
  facts: Array<{ text: string }>,
  openai: OpenAI,
  sqliteDir: string,
  opts: { model: string; dryRun?: boolean },
): Promise<BuildLanguageKeywordsResult> {
  const samples = collectSamplesFromFacts(facts);
  const topLanguages = await detectTopLanguages(samples, openai, opts.model);
  const toTranslate = topLanguages.filter((c) => c !== "en");
  if (toTranslate.length === 0 && samples.length > 0) {
    return { ok: true, path: join(sqliteDir, LANG_FILE_NAME), topLanguages: ["en"], languagesAdded: 0 };
  }

  const { translations, triggerStructures, extraction } = await generateIntentBasedLanguages(
    toTranslate.length > 0 ? toTranslate : ["en"],
    openai,
    opts.model,
  );

  const merged = buildMergedFromTranslations(translations);
  const directiveSignalsByCategory: Record<string, string[]> = {};
  for (const [fileKey, mergedKey] of Object.entries({
    explicit_memory: "directiveExplicitMemory",
    future_behavior: "directiveFutureBehavior",
    absolute_rule: "directiveAbsoluteRule",
    preference: "directivePreference",
    warning: "directiveWarning",
    procedural: "directiveProcedural",
    implicit_correction: "directiveImplicitCorrection",
    conditional_rule: "directiveConditionalRule",
    correction: "correctionSignals",
  } as Record<string, string>)) {
    const list = merged[mergedKey as KeywordGroup];
    if (Array.isArray(list) && list.length > 0) directiveSignalsByCategory[fileKey] = list;
  }
  const reinforcementCategories: Record<string, string[]> = {};
  for (const [fileKey, mergedKey] of Object.entries({
    strongPraise: "reinforcementStrongPraise",
    methodConfirmation: "reinforcementMethodConfirmation",
    relief: "reinforcementRelief",
    comparativePraise: "reinforcementComparativePraise",
    sharingSignals: "reinforcementSharingSignals",
  } as Record<string, string>)) {
    const list = merged[mergedKey as KeywordGroup];
    if (Array.isArray(list) && list.length > 0) reinforcementCategories[fileKey] = list;
  }
  reinforcementCategories.genericPoliteness = ["thanks", "thank you", "ok", "okay", "got it"];

  const filePath = join(sqliteDir, LANG_FILE_NAME);
  const data: LanguageKeywordsFile = {
    version: 2,
    detectedAt: new Date().toISOString(),
    topLanguages: topLanguages.length > 0 ? topLanguages : ["en"],
    translations,
    triggerStructures: Object.keys(triggerStructures).length > 0 ? triggerStructures : undefined,
    extraction: Object.keys(extraction).length > 0 ? extraction : undefined,
    directiveSignalsByCategory: Object.keys(directiveSignalsByCategory).length > 0 ? directiveSignalsByCategory : undefined,
    reinforcementCategories: Object.keys(reinforcementCategories).length > 0 ? reinforcementCategories : undefined,
  };

  if (opts.dryRun) {
    return {
      ok: true,
      path: filePath,
      topLanguages: data.topLanguages,
      languagesAdded: Object.keys(translations).length,
    };
  }

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    await clearKeywordCache();
  } catch (e) {
    return { ok: false, error: String(e) };
  }

  return {
    ok: true,
    path: filePath,
    topLanguages: data.topLanguages,
    languagesAdded: Object.keys(translations).length,
  };
}
