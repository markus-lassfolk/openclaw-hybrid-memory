/**
 * Build safe regexes from per-language extraction templates and run them.
 * Used when .language-keywords.json (v2) provides extraction building blocks.
 */

import type { LanguageExtractionTemplate } from "./language-keywords.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type ExtractionResult = {
  entity: string | null;
  key: string | null;
  value: string | null;
};

type PatternRunner = (text: string) => ExtractionResult | null;

/**
 * Build pattern runners from a language's extraction template.
 * Each runner returns { entity, key, value } or null.
 */
export function buildExtractionRunners(
  template: LanguageExtractionTemplate,
): PatternRunner[] {
  const runners: PatternRunner[] = [];

  if (template.decision && template.decision.verbs.length > 0) {
    const verbs = template.decision.verbs.map(escapeRegex).join("|");
    const conn = template.decision.connectors.length > 0
      ? template.decision.connectors.map(escapeRegex).join("|")
      : "(?:because|since|for|due to|over)";
    const re = new RegExp(
      `(?:${verbs})\\s+(?:to\\s+)?(?:use\\s+)?(.+?)(?:\\s+(?:${conn})\\s+(.+?))?\\.?$`,
      "i",
    );
    runners.push((text) => {
      const m = text.match(re);
      if (!m) return null;
      return {
        entity: "decision",
        key: m[1].trim().slice(0, 100),
        value: (m[2]?.trim() || "no rationale recorded").slice(0, 200),
      };
    });
  }

  if (template.choiceOver && template.choiceOver.verbs.length > 0 && template.choiceOver.rejectors.length > 0) {
    const verbs = template.choiceOver.verbs.map(escapeRegex).join("|");
    const rejectors = template.choiceOver.rejectors.map(escapeRegex).join("|");
    const conn = template.choiceOver.connectors.length > 0
      ? template.choiceOver.connectors.map(escapeRegex).join("|")
      : "because|since|for|due to";
    const re = new RegExp(
      `(?:${verbs})\\s+(.+?)\\s+(?:${rejectors})\\s+(.+?)(?:\\s+(?:${conn})\\s+(.+?))?\\.?$`,
      "i",
    );
    runners.push((text) => {
      const m = text.match(re);
      if (!m) return null;
      const key = `${m[1].trim()} over ${m[2].trim()}`.slice(0, 100);
      const value = (m[3]?.trim() || "preference").slice(0, 200);
      return { entity: "decision", key, value };
    });
  }

  if (template.convention && (template.convention.always.length > 0 || template.convention.never.length > 0)) {
    const always = template.convention.always.map(escapeRegex).join("|");
    const never = template.convention.never.map(escapeRegex).join("|");
    if (never) {
      const reNever = new RegExp(`(?:${never})\\s+(.+?)\\.?$`, "i");
      runners.push((text) => {
        const m = text.match(reNever);
        if (!m) return null;
        return { entity: "convention", key: m[1].trim().slice(0, 100), value: "never" };
      });
    }
    if (always) {
      const reAlways = new RegExp(`(?:${always})\\s+(.+?)\\.?$`, "i");
      runners.push((text) => {
        const m = text.match(reAlways);
        if (!m) return null;
        return { entity: "convention", key: m[1].trim().slice(0, 100), value: "always" };
      });
    }
  }

  if (template.possessive && template.possessive.possessiveWords.length > 0 && template.possessive.isWords.length > 0) {
    const poss = template.possessive.possessiveWords.map(escapeRegex).join("|");
    const isWords = template.possessive.isWords.map(escapeRegex).join("|");
    const re = new RegExp(
      `(?:${poss})\\s+(\\S+)\\s+(?:${isWords})\\s+(.+?)\\.?$`,
      "i",
    );
    runners.push((text) => {
      const m = text.match(re);
      if (!m) return null;
      return {
        entity: "user",
        key: m[1].trim(),
        value: m[2].trim().slice(0, 200),
      };
    });
  }

  if (template.preference && template.preference.subject.length > 0 && template.preference.verbs.length > 0) {
    const subject = template.preference.subject.map(escapeRegex).join("|");
    const verbs = template.preference.verbs.map(escapeRegex).join("|");
    const re = new RegExp(
      `(?:${subject})\\s+(?:${verbs})\\s+(.+?)\\.?$`,
      "i",
    );
    runners.push((text) => {
      const m = text.match(re);
      if (!m) return null;
      const verbMatch = text.match(new RegExp(`(?:${subject})\\s+(${template.preference!.verbs.map(escapeRegex).join("|")})\\s+(.+?)\\.?$`, "i"));
      const verb = verbMatch ? verbMatch[1] : "prefer";
      return {
        entity: "user",
        key: verb,
        value: m[1].trim().slice(0, 200),
      };
    });
  }

  if (template.nameIntro && template.nameIntro.verbs.length > 0) {
    const verbs = template.nameIntro.verbs.map(escapeRegex).join("|");
    const re = new RegExp(`(?:${verbs})\\s+(.+?)\\.?$`, "i");
    runners.push((text) => {
      const m = text.match(re);
      if (!m) return null;
      return {
        entity: "entity",
        key: "name",
        value: m[1].trim().slice(0, 100),
      };
    });
  }

  return runners;
}

/**
 * Run all extraction runners from all languages; return first non-null result.
 */
export function tryExtractionFromTemplates(
  templates: Record<string, LanguageExtractionTemplate>,
  text: string,
): ExtractionResult | null {
  for (const [, template] of Object.entries(templates)) {
    const runners = buildExtractionRunners(template);
    for (const run of runners) {
      const result = run(text);
      if (result) return result;
    }
  }
  return null;
}
