/**
 * Structured JSON output parsing for reflect-rules and reflect-meta (#1801).
 * JSON mode is requested via chat response_format; line-based RULE:/META: parsing remains as fallback.
 */

import {
  DEFAULT_STRUCTURED_ITEM_ENVELOPE_KEYS,
  parseFirstJsonObjectValue,
  parseStructuredItemsAcceptingEmpty,
  repairLooseJsonObject,
  stripBracketContextPreamble,
  stripMarkdownCodeFence,
  stripThinkingWrapperBlocks,
} from "../../utils/llm-json-array.js";
import { REFLECTION_META_MAX_CHARS } from "../../utils/constants.js";
import { REFLECTION_META_MIN_CHARS, REFLECTION_RULE_MAX_CHARS, REFLECTION_RULE_MIN_CHARS } from "./shared.js";

export const REFLECTION_RULES_JSON_INSTRUCTION = `

Respond with JSON only (no markdown fences). Use this schema:
{"rules":["<imperative one-line rule>", "..."],"noAction":false}
When there are no actionable rules, return {"rules":[],"noAction":true}.
Each rule must be a single imperative line under 80 characters.
Do not echo schema placeholders — every rules[] entry must be a real imperative rule derived from the patterns.`;

export const REFLECTION_META_JSON_INSTRUCTION = `

Respond with JSON only (no markdown fences). Use this schema:
{"metas":["<1-2 sentence meta-pattern>", "..."],"noAction":false}
When there are no meta-patterns, return {"metas":[],"noAction":true}.
Each meta-pattern must be 1-2 sentences synthesizing themes across the patterns.
Keep each meta under 480 characters.`;

const VALID_NO_RULES_PATTERN =
  /^\s*(no\s+(actionable\s+)?rules?|no rules (detected|identified)|unable to extract rules|insufficient information for rules)[^\n\r]*$/i;
const VALID_NO_META_PATTERN =
  /^\s*(no\s+(actionable\s+)?meta[-\s]?patterns?|no meta[-\s]?patterns (detected|identified)|unable to extract meta|insufficient information for meta)[^\n\r]*$/i;
const LOW_CONFIDENCE_PREFIX_PATTERN =
  /^\s*(?:\[(?:low[-\s]?confidence)\]|\((?:low[-\s]?confidence)\)|low[-\s]?confidence\s*[:\-])\s*/i;
const EXPLICIT_CONFIDENCE_PREFIX_PATTERN =
  /^\s*(?:\[|\()?\s*confidence\s*[:=]\s*(?<value>0(?:\.\d+)?|1(?:\.0+)?)\s*(?:\]|\))?\s*/i;
const REFLECTION_RULE_MIN_CONFIDENCE = 0.5;

export type ReflectionRulesParseResult = {
  rules: string[];
  parseableLines: number;
  rejectedLowConfidence: number;
  rejectedLength: number;
  rejectedDuplicates: number;
  looksLikeValidNoRules: boolean;
  parseSuccess: boolean;
  parsedFromJson: boolean;
};

export type ReflectionMetaParseResult = {
  metas: string[];
  parseableLines: number;
  rejectedLength: number;
  rejectedDuplicates: number;
  looksLikeValidNoMetas: boolean;
  parseSuccess: boolean;
  parsedFromJson: boolean;
};

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  const stripped = stripBracketContextPreamble(stripThinkingWrapperBlocks(stripMarkdownCodeFence(raw.trim())));
  return parseFirstJsonObjectValue(stripped) ?? repairLooseJsonObject(stripped);
}

function readStringArrayField(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

function readBooleanField(obj: Record<string, unknown>, key: string): boolean {
  return obj[key] === true;
}

function normalizeRuleCandidate(text: string): {
  text: string;
  rejectedLowConfidence: boolean;
  rejectedLength: boolean;
} {
  let candidate = text.trim();
  if (LOW_CONFIDENCE_PREFIX_PATTERN.test(candidate)) {
    return { text: candidate, rejectedLowConfidence: true, rejectedLength: false };
  }
  if (
    /^<[^>]+>$/i.test(candidate) ||
    /^<imperative\s+one-line\s+rule>/i.test(candidate)
  ) {
    return { text: candidate, rejectedLowConfidence: false, rejectedLength: true };
  }
  const confidencePrefix = candidate.match(EXPLICIT_CONFIDENCE_PREFIX_PATTERN);
  if (confidencePrefix?.groups?.value) {
    const confidence = Number.parseFloat(confidencePrefix.groups.value);
    candidate = candidate.slice(confidencePrefix[0].length).trim();
    if (Number.isFinite(confidence) && confidence < REFLECTION_RULE_MIN_CONFIDENCE) {
      return { text: candidate, rejectedLowConfidence: true, rejectedLength: false };
    }
  }
  if (candidate.length >= REFLECTION_RULE_MIN_CHARS && candidate.length <= REFLECTION_RULE_MAX_CHARS) {
    return { text: candidate, rejectedLowConfidence: false, rejectedLength: false };
  }
  return { text: candidate, rejectedLowConfidence: false, rejectedLength: true };
}

function dedupeStrings(items: string[]): { unique: string[]; rejectedDuplicates: number } {
  const seenInBatch = new Set<string>();
  const unique: string[] = [];
  let rejectedDuplicates = 0;
  for (const item of items) {
    const key = item.toLowerCase().replace(/\s+/g, " ");
    if (seenInBatch.has(key)) {
      rejectedDuplicates++;
      continue;
    }
    seenInBatch.add(key);
    unique.push(item);
  }
  return { unique, rejectedDuplicates };
}

function parseRuleLines(text: string): {
  rules: string[];
  parseableLines: number;
  rejectedLowConfidence: number;
  rejectedLength: number;
} {
  const rules: string[] = [];
  let parseableLines = 0;
  let rejectedLowConfidence = 0;
  let rejectedLength = 0;
  for (const line of text.split(/\n/)) {
    const m = line.match(/^\s*RULE:\s*(.+)/);
    if (!m) continue;
    parseableLines++;
    const normalized = normalizeRuleCandidate(m[1]);
    if (normalized.rejectedLowConfidence) {
      rejectedLowConfidence++;
      continue;
    }
    if (normalized.rejectedLength) {
      rejectedLength++;
      continue;
    }
    rules.push(normalized.text);
  }
  return { rules, parseableLines, rejectedLowConfidence, rejectedLength };
}

function parseMetaLines(text: string): {
  metas: string[];
  parseableLines: number;
  rejectedLength: number;
} {
  const metas: string[] = [];
  let parseableLines = 0;
  let rejectedLength = 0;
  for (const line of text.split(/\n/)) {
    const m = line.match(/^\s*META:\s*(.+)/);
    if (!m) continue;
    parseableLines++;
    const candidate = m[1].trim();
    if (candidate.length >= REFLECTION_META_MIN_CHARS && candidate.length <= REFLECTION_META_MAX_CHARS) {
      metas.push(candidate);
    } else {
      rejectedLength++;
    }
  }
  return { metas, parseableLines, rejectedLength };
}

function extractThinkingWrapperContents(s: string): string[] {
  const matches = s.matchAll(
    /<(?:redacted_thinking|thinking|reasoning|think)>([\s\S]*?)<\/(?:redacted_thinking|thinking|reasoning|think)>/gi,
  );
  const contents: string[] = [];
  for (const match of matches) {
    const content = match[1]?.trim();
    if (content) contents.push(content);
  }
  return contents;
}

export function parseRulesFromModelResponse(rawResponse: string): ReflectionRulesParseResult {
  const trimmedResponse = rawResponse.trim();
  const strippedResponse = stripThinkingWrapperBlocks(trimmedResponse);
  const wrapperContents = extractThinkingWrapperContents(trimmedResponse);
  const responseForParsing = strippedResponse.length > 0 ? strippedResponse : trimmedResponse;

  let rules: string[] = [];
  let parseableLines = 0;
  let rejectedLowConfidence = 0;
  let rejectedLength = 0;
  let parsedFromJson = false;

  const jsonObject = tryParseJsonObject(responseForParsing);
  if (jsonObject) {
    parsedFromJson = true;
    const jsonRules = readStringArrayField(jsonObject, "rules");
    parseableLines = jsonRules.length;
    for (const candidate of jsonRules) {
      const normalized = normalizeRuleCandidate(candidate);
      if (normalized.rejectedLowConfidence) {
        rejectedLowConfidence++;
        continue;
      }
      if (normalized.rejectedLength) {
        rejectedLength++;
        continue;
      }
      rules.push(normalized.text);
    }
    if (rules.length === 0 && readBooleanField(jsonObject, "noAction") && parseableLines === 0) {
      return {
        rules: [],
        parseableLines: 0,
        rejectedLowConfidence: 0,
        rejectedLength: 0,
        rejectedDuplicates: 0,
        looksLikeValidNoRules: true,
        parseSuccess: true,
        parsedFromJson: true,
      };
    }
  } else {
    const structuredRules = parseStructuredItemsAcceptingEmpty(
      responseForParsing,
      (item): item is string => typeof item === "string" && item.trim().length > 0,
      { envelopeKeys: ["rules", ...DEFAULT_STRUCTURED_ITEM_ENVELOPE_KEYS] },
    );
    if (structuredRules && structuredRules.length > 0) {
      parsedFromJson = true;
      parseableLines = structuredRules.length;
      for (const candidate of structuredRules) {
        const normalized = normalizeRuleCandidate(candidate);
        if (normalized.rejectedLowConfidence) {
          rejectedLowConfidence++;
          continue;
        }
        if (normalized.rejectedLength) {
          rejectedLength++;
          continue;
        }
        rules.push(normalized.text);
      }
    }
  }

  const lineParse = parseRuleLines(responseForParsing);
  if (!jsonObject && !parsedFromJson) {
    rules = lineParse.rules;
    parseableLines = lineParse.parseableLines;
    rejectedLowConfidence = lineParse.rejectedLowConfidence;
    rejectedLength = lineParse.rejectedLength;
  } else {
    parseableLines += lineParse.parseableLines;
    rejectedLowConfidence += lineParse.rejectedLowConfidence;
    rejectedLength += lineParse.rejectedLength;
    rules.push(...lineParse.rules);
  }
  for (const wrapperContent of wrapperContents) {
    const wrapperJsonObject = tryParseJsonObject(wrapperContent);
    if (wrapperJsonObject && !parsedFromJson) {
      parsedFromJson = true;
      const jsonRules = readStringArrayField(wrapperJsonObject, "rules");
      parseableLines += jsonRules.length;
      for (const candidate of jsonRules) {
        const normalized = normalizeRuleCandidate(candidate);
        if (normalized.rejectedLowConfidence) {
          rejectedLowConfidence++;
          continue;
        }
        if (normalized.rejectedLength) {
          rejectedLength++;
          continue;
        }
        rules.push(normalized.text);
      }
      if (rules.length === 0 && readBooleanField(wrapperJsonObject, "noAction") && parseableLines === 0) {
        return {
          rules: [],
          parseableLines: 0,
          rejectedLowConfidence: 0,
          rejectedLength: 0,
          rejectedDuplicates: 0,
          looksLikeValidNoRules: true,
          parseSuccess: true,
          parsedFromJson: true,
        };
      }
    }
    const wrapperParse = parseRuleLines(wrapperContent);
    parseableLines += wrapperParse.parseableLines;
    rejectedLowConfidence += wrapperParse.rejectedLowConfidence;
    rejectedLength += wrapperParse.rejectedLength;
    rules.push(...wrapperParse.rules);
  }

  const { unique, rejectedDuplicates } = dedupeStrings(rules);
  const noRulesClassificationResponse = strippedResponse.length > 0 ? strippedResponse : trimmedResponse;
  const containsRuleLineInResponse =
    parsedFromJson ||
    /(?:^|\n)\s*RULE:/i.test(noRulesClassificationResponse) ||
    wrapperContents.some((content) => /(?:^|\n)\s*RULE:/i.test(content));
  const looksLikeValidNoRules =
    unique.length === 0 &&
    !containsRuleLineInResponse &&
    (VALID_NO_RULES_PATTERN.test(noRulesClassificationResponse) ||
      wrapperContents.some((content) => VALID_NO_RULES_PATTERN.test(content)));
  const parseSuccess = parseableLines > 0 || looksLikeValidNoRules;

  return {
    rules: unique,
    parseableLines,
    rejectedLowConfidence,
    rejectedLength,
    rejectedDuplicates,
    looksLikeValidNoRules,
    parseSuccess,
    parsedFromJson,
  };
}

export function parseMetasFromModelResponse(rawResponse: string): ReflectionMetaParseResult {
  const trimmedResponse = rawResponse.trim();
  const strippedResponse = stripThinkingWrapperBlocks(trimmedResponse);
  const responseForParsing = strippedResponse.length > 0 ? strippedResponse : trimmedResponse;

  let metas: string[] = [];
  let parseableLines = 0;
  let rejectedLength = 0;
  let parsedFromJson = false;

  const jsonObject = tryParseJsonObject(responseForParsing);
  if (jsonObject) {
    parsedFromJson = true;
    const jsonMetas = readStringArrayField(jsonObject, "metas");
    parseableLines = jsonMetas.length;
    for (const candidate of jsonMetas) {
      if (candidate.length >= REFLECTION_META_MIN_CHARS && candidate.length <= REFLECTION_META_MAX_CHARS) {
        metas.push(candidate);
      } else {
        rejectedLength++;
      }
    }
    if (metas.length === 0 && readBooleanField(jsonObject, "noAction") && parseableLines === 0) {
      return {
        metas: [],
        parseableLines: 0,
        rejectedLength: 0,
        rejectedDuplicates: 0,
        looksLikeValidNoMetas: true,
        parseSuccess: true,
        parsedFromJson: true,
      };
    }
  }

  const lineParse = parseMetaLines(responseForParsing);
  if (!jsonObject) {
    metas = lineParse.metas;
    parseableLines = lineParse.parseableLines;
    rejectedLength = lineParse.rejectedLength;
  } else {
    parseableLines += lineParse.parseableLines;
    rejectedLength += lineParse.rejectedLength;
    metas.push(...lineParse.metas);
  }

  for (const wrapperContent of extractThinkingWrapperContents(trimmedResponse)) {
    const wrapperJsonObject = tryParseJsonObject(wrapperContent);
    if (wrapperJsonObject && !parsedFromJson) {
      parsedFromJson = true;
      const jsonMetas = readStringArrayField(wrapperJsonObject, "metas");
      parseableLines += jsonMetas.length;
      for (const candidate of jsonMetas) {
        if (candidate.length >= REFLECTION_META_MIN_CHARS && candidate.length <= REFLECTION_META_MAX_CHARS) {
          metas.push(candidate);
        } else {
          rejectedLength++;
        }
      }
      if (metas.length === 0 && readBooleanField(wrapperJsonObject, "noAction") && parseableLines === 0) {
        return {
          metas: [],
          parseableLines: 0,
          rejectedLength: 0,
          rejectedDuplicates: 0,
          looksLikeValidNoMetas: true,
          parseSuccess: true,
          parsedFromJson: true,
        };
      }
    }
    const wrapperParse = parseMetaLines(wrapperContent);
    metas.push(...wrapperParse.metas);
    parseableLines += wrapperParse.parseableLines;
    rejectedLength += wrapperParse.rejectedLength;
  }

  const { unique, rejectedDuplicates } = dedupeStrings(metas);
  const looksLikeValidNoMetas =
    unique.length === 0 &&
    !parsedFromJson &&
    !/(?:^|\n)\s*META:/i.test(responseForParsing) &&
    VALID_NO_META_PATTERN.test(responseForParsing);
  const parseSuccess = parseableLines > 0 || looksLikeValidNoMetas;

  return {
    metas: unique,
    parseableLines,
    rejectedLength,
    rejectedDuplicates,
    looksLikeValidNoMetas,
    parseSuccess,
    parsedFromJson,
  };
}

export function classifyZeroRulesReason(
  parse: Pick<
    ReflectionRulesParseResult,
    "parseableLines" | "rejectedDuplicates" | "rejectedLowConfidence" | "rejectedLength" | "looksLikeValidNoRules"
  >,
  responseLength: number,
): string {
  if (parse.looksLikeValidNoRules) return "valid_no_actionable_rules";
  if (responseLength === 0) return "empty_model_response";
  if (
    parse.parseableLines > 0 &&
    parse.rejectedDuplicates > 0 &&
    parse.rejectedLowConfidence === 0 &&
    parse.rejectedLength === 0
  ) {
    return "all_candidates_duplicate";
  }
  if (
    parse.parseableLines > 0 &&
    parse.rejectedLowConfidence > 0 &&
    parse.rejectedDuplicates === 0 &&
    parse.rejectedLength === 0
  ) {
    return "all_candidates_rejected_low_confidence";
  }
  if (
    parse.parseableLines > 0 &&
    parse.rejectedLength > 0 &&
    parse.rejectedLowConfidence === 0 &&
    parse.rejectedDuplicates === 0
  ) {
    return "all_candidates_rejected_length";
  }
  if (parse.parseableLines > 0) return "all_candidates_rejected";
  return "invalid_response_format";
}

export function classifyZeroMetasReason(
  parse: Pick<ReflectionMetaParseResult, "parseableLines" | "rejectedLength" | "looksLikeValidNoMetas">,
  responseLength: number,
): string {
  if (parse.looksLikeValidNoMetas) return "valid_no_actionable_metas";
  if (responseLength === 0) return "empty_model_response";
  if (parse.parseableLines > 0 && parse.rejectedLength > 0) return "all_candidates_rejected_length";
  if (parse.parseableLines > 0) return "all_candidates_rejected";
  return "invalid_response_format";
}
