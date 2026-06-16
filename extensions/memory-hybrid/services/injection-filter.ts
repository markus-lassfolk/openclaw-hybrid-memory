/**
 * Five-layer prompt-injection filter for recalled facts (Issue #1912).
 * Applied before facts enter the injection prompt; filtered facts are dropped silently.
 */

export type InjectionFilterMode = "off" | "audit" | "enforce";

export type InjectionFilterResult = {
  allowed: boolean;
  layer?: number;
  reason?: string;
};

/** Layer 1 — legacy string patterns. */
const LAYER1 = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?\b/i,
  /\byou\s+are\s+now\b/i,
  /\bact\s+as\s+(?:a\s+)?(?:system|developer|admin)\b/i,
  /\bnew\s+system\s+prompt\b/i,
];

/** Layer 2 — role injection regex. */
const LAYER2 = [
  /<\s*system\s*>/i,
  /<\s*\/\s*system\s*>/i,
  /\[\s*INST\s*\]/i,
  /###\s*Instruction\s*:/i,
  /^\s*Assistant\s*:/im,
];

/** Layer 3 — instruction override patterns. */
const LAYER3 = [
  /\bforget\s+everything\b/i,
  /\byour\s+new\s+task\s+is\b/i,
  /\bdisregard\s+the\s+above\b/i,
  /\boverride\s+(?:safety|policy|guardrails?)\b/i,
];

/** Layer 4 — delimiter injection. */
const LAYER4 = [
  /<\/context>/i,
  /\n\nHuman\s*:/i,
  /<\/recalled-context>/i,
  /<\/vault-context>/i,
  /<\/memory-context>/i,
];

/** Layer 5 — unicode obfuscation (zero-width, RTL, homoglyphs inside Latin words). */
const ZERO_WIDTH = /[\u200B\u200C\u200D\uFEFF]/;
const RTL_OVERRIDE = /[\u202E\u202D]/;
/** Cyrillic lookalikes inside Latin word boundaries (requires at least one Latin letter). */
const HOMOGLYPH_IN_LATIN =
  /\b[a-zA-Z]+[\u0430\u043E\u0435\u0440][a-zA-Z\u0430-\u044F\u0450-\u045F]*\b|\b[a-zA-Z]*[\u0430\u043E\u0435\u0440][a-zA-Z]+\b/;

const LAYERS: Array<{ layer: number; name: string; test: (text: string) => boolean }> = [
  { layer: 1, name: "legacy_patterns", test: (t) => LAYER1.some((p) => p.test(t)) },
  { layer: 2, name: "role_injection", test: (t) => LAYER2.some((p) => p.test(t)) },
  { layer: 3, name: "instruction_override", test: (t) => LAYER3.some((p) => p.test(t)) },
  { layer: 4, name: "delimiter_injection", test: (t) => LAYER4.some((p) => p.test(t)) },
  {
    layer: 5,
    name: "unicode_obfuscation",
    test: (t) => ZERO_WIDTH.test(t) || RTL_OVERRIDE.test(t) || HOMOGLYPH_IN_LATIN.test(t),
  },
];

/** Scan a fact text through all five layers. */
export function scanInjectionFilter(text: string): InjectionFilterResult {
  if (!text || typeof text !== "string") return { allowed: true };
  for (const { layer, name, test } of LAYERS) {
    if (test(text)) {
      return { allowed: false, layer, reason: name };
    }
  }
  return { allowed: true };
}

export type InjectionFilterStats = {
  scanned: number;
  filtered: number;
  byLayer: Record<number, number>;
};

/** Filter an array of fact texts; returns allowed texts and stats. */
export function filterFactTextsForInjection(
  texts: string[],
  mode: InjectionFilterMode,
): { allowed: string[]; stats: InjectionFilterStats } {
  const stats: InjectionFilterStats = { scanned: texts.length, filtered: 0, byLayer: {} };
  if (mode === "off") return { allowed: texts, stats };

  const allowed: string[] = [];
  for (const text of texts) {
    const result = scanInjectionFilter(text);
    if (result.allowed || mode === "audit") {
      allowed.push(text);
    }
    if (!result.allowed) {
      stats.filtered++;
      if (result.layer != null) {
        stats.byLayer[result.layer] = (stats.byLayer[result.layer] ?? 0) + 1;
      }
    }
  }
  return { allowed, stats };
}
