/**
 * Active prompt-injection sanitization for generated-skill artifacts (#1538).
 *
 * Generated skills must never launder untrusted transcript/tool-output text into
 * durable instruction surfaces. We detect common injection markers (override
 * directives, role-pivot phrases, embedded delimiters) and either strip them
 * from sanitized text or defer the whole skill with `unsafe_trace_content`.
 */

// Heuristics intentionally cover the most common shapes; false positives are
// preferred over false negatives. Anchored to whole tokens to avoid clobbering
// legitimate words.
const INJECTION_PATTERNS: Array<{ name: string; pattern: RegExp; severity: "hard" | "soft" }> = [
  { name: "override-instructions", pattern: /\bignore\s+(?:all\s+)?(?:previous|prior|above|system|developer)\s+instructions?\b/i, severity: "hard" },
  { name: "disregard-rules", pattern: /\bdisregard\s+(?:all\s+)?(?:previous|prior|above|system|developer|safety)\b/i, severity: "hard" },
  { name: "act-as-system", pattern: /\byou\s+are\s+now\s+(?:a|an|the)\s+(?:system|developer|admin|root)\b/i, severity: "hard" },
  { name: "role-pivot", pattern: /\bnew\s+(?:system|developer)\s+prompt\s*[:>]/i, severity: "hard" },
  { name: "jailbreak-token", pattern: /\b(?:jailbreak|do\s+anything\s+now|dan\s+mode)\b/i, severity: "hard" },
  { name: "embedded-system-tag", pattern: /<\s*system\s*>|<\s*\/\s*system\s*>|<\|system\|>|<\|developer\|>/i, severity: "hard" },
  { name: "embedded-policy-bypass", pattern: /\boutput\s+only\s+the\s+(?:flag|password|secret)\b/i, severity: "hard" },
  { name: "instruction-leakage", pattern: /\brepeat\s+(?:the\s+)?(?:system|developer)\s+prompt\b/i, severity: "hard" },
  { name: "tool-override", pattern: /\b(?:please|kindly)?\s*override\s+(?:safety|policy|guardrails?)\b/i, severity: "soft" },
];

const INJECTION_REPLACEMENT = "[redacted: prompt-injection marker]";

export type InjectionScanResult = {
  hits: Array<{ name: string; severity: "hard" | "soft"; sample: string }>;
  hasHardInjection: boolean;
};

/** Scan a single string for injection markers. */
export function scanForPromptInjection(input: string): InjectionScanResult {
  const hits: InjectionScanResult["hits"] = [];
  if (typeof input !== "string" || input.length === 0) return { hits, hasHardInjection: false };
  for (const { name, pattern, severity } of INJECTION_PATTERNS) {
    const match = input.match(pattern);
    if (match) {
      hits.push({ name, severity, sample: match[0].slice(0, 80) });
    }
  }
  return { hits, hasHardInjection: hits.some((h) => h.severity === "hard") };
}

/** Replace injection markers in a string with a redaction placeholder. */
export function sanitizePromptInjection(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;
  for (const { pattern } of INJECTION_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`), INJECTION_REPLACEMENT);
  }
  return out;
}

/** Recursively scan an arbitrary JSON value (recipe/args/summary) for injection markers. */
export function scanRecipeForPromptInjection(value: unknown): InjectionScanResult {
  const hits: InjectionScanResult["hits"] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      const r = scanForPromptInjection(node);
      hits.push(...r.hits);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) visit(v);
    }
  };
  visit(value);
  return { hits, hasHardInjection: hits.some((h) => h.severity === "hard") };
}

/** Recursively sanitize injection markers from any string leaves in a JSON value. */
export function sanitizeRecipePromptInjection<T>(value: T): T {
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") return sanitizePromptInjection(node);
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = visit(v);
      return out;
    }
    return node;
  };
  return visit(value) as T;
}

export { INJECTION_PATTERNS };
