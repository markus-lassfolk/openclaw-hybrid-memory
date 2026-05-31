import type { EntityMentionLabel } from "../backends/facts-db/entity-layer.js";
import { normalizeEntityKey } from "../backends/facts-db/entity-layer.js";

export type EntityMentionRejectReason =
  | "short"
  | "numeric"
  | "timestamp_fragment"
  | "generic_term"
  | "low_confidence"
  | "role_person"
  | "bad_type";

export type EntityMentionCandidate = {
  label: string;
  surfaceText: string;
  normalizedSurface?: string;
  confidence?: number;
};

export type CanonicalizedEntityMention = {
  accepted: true;
  label: EntityMentionLabel;
  surfaceText: string;
  normalizedSurface: string;
  confidence: number;
};

export type RejectedEntityMention = {
  accepted: false;
  reason: EntityMentionRejectReason;
};

const GENERIC_TERMS = new Set([
  "api",
  "cli",
  "pr",
  "issue",
  "status",
  "task",
  "done",
  "open",
  "closed",
  "blocked",
  "waiting",
  "failed",
  "session",
  "memory",
  "fact",
]);

const MODEL_VERSION = "\\d+(?:\\.\\d+)*(?:[-\\s]?[a-z0-9]+)*";
const MODEL_MATCHER = new RegExp(
  `\\b(gpt[-\\s]?${MODEL_VERSION}|claude[-\\s]?${MODEL_VERSION}|gemini[-\\s]?${MODEL_VERSION}|minimax[-\\s]?${MODEL_VERSION}|o${MODEL_VERSION}|(gpt|claude|gemini|minimax|sonnet|opus)[-\\s](pro|plus|turbo|ultra|flash|preview|vision|instruct))\\b`,
  "i",
);

const CANONICAL_LABEL_MAP: Array<{ match: RegExp; label: EntityMentionLabel; canonicalNormalized: string }> = [
  { match: MODEL_MATCHER, label: "MODEL", canonicalNormalized: "" },
  { match: /^gh$/i, label: "TOOL", canonicalNormalized: "gh" },
  { match: /^npm$/i, label: "TOOL", canonicalNormalized: "npm" },
  { match: /^jq$/i, label: "TOOL", canonicalNormalized: "jq" },
  { match: /\bgithub\b/i, label: "SERVICE", canonicalNormalized: "github" },
  { match: /\bwhatsapp\b/i, label: "SERVICE", canonicalNormalized: "whatsapp" },
  { match: /\btelegram\b/i, label: "SERVICE", canonicalNormalized: "telegram" },
  { match: /\bhome assistant\b|^ha$/i, label: "SERVICE", canonicalNormalized: "home assistant" },
  { match: /\bduckflux\b/i, label: "PROJECT", canonicalNormalized: "duckflux" },
  {
    match: /\bhybrid[- ]memory\b|\bopenclaw-hybrid-memory\b/i,
    label: "PROJECT",
    canonicalNormalized: "openclaw-hybrid-memory",
  },
  { match: /^(forge|scholar|maeve|ralph)$/i, label: "AGENT", canonicalNormalized: "" },
  { match: /^(surgeon|council)$/i, label: "ROLE", canonicalNormalized: "" },
];

const ACRONYM_ALLOWLIST = new Map<string, EntityMentionLabel>([
  ["HA", "SERVICE"],
  ["CI", "TOOL"],
]);

function minConfidenceForLabel(label: EntityMentionLabel): number {
  return 0.75;
}

function normalizeSurfaceText(value: string): string {
  return value.trim();
}

function isNumericLike(value: string): boolean {
  return /^[\d\-:./]+$/.test(value);
}

function includesTimestampFragment(value: string): boolean {
  return /\b\d{9,13}\b/.test(value);
}

function normalizeModelCanonical(value: string): string {
  const normalized = normalizeEntityKey(value).replace(/\s+/g, "-");
  return normalized;
}

function canonicalizeByKnownMap(
  surfaceText: string,
  normalizedSurface: string,
  fallbackLabel: EntityMentionLabel,
): { label: EntityMentionLabel; normalizedSurface: string } {
  for (const rule of CANONICAL_LABEL_MAP) {
    const surfaceMatch = rule.match.exec(surfaceText);
    const normalizedMatch = rule.match.exec(normalizedSurface);
    if (!surfaceMatch && !normalizedMatch) continue;
    if (fallbackLabel === "PERSON" && rule.label === "MODEL") {
      continue;
    }
    if (rule.label === "MODEL") {
      const matchedText = surfaceMatch ? surfaceMatch[0] : normalizedMatch![0];
      return {
        label: "MODEL",
        normalizedSurface: normalizeModelCanonical(matchedText),
      };
    }
    return {
      label: rule.label,
      normalizedSurface:
        rule.canonicalNormalized || (normalizedMatch ? normalizedSurface : normalizeEntityKey(surfaceText)),
    };
  }
  return { label: fallbackLabel, normalizedSurface };
}

export function makeEntityMentionKey(label: string, normalizedSurface: string): string {
  return `${label}\u0000${normalizedSurface}`;
}

export function countReason(target: Record<string, number>, reason: string): void {
  target[reason] = (target[reason] ?? 0) + 1;
}

export function canonicalizeEntityMention(
  candidate: EntityMentionCandidate,
): CanonicalizedEntityMention | RejectedEntityMention {
  const baseSurface = normalizeSurfaceText(candidate.surfaceText ?? "");
  if (baseSurface.length < 2) return { accepted: false, reason: "short" };
  const acronymType = ACRONYM_ALLOWLIST.get(baseSurface.toUpperCase());
  const hasKnownShortMapping = CANONICAL_LABEL_MAP.some((rule) => rule.match.test(baseSurface));
  if (baseSurface.length < 3 && !acronymType && !hasKnownShortMapping) return { accepted: false, reason: "short" };
  if (isNumericLike(baseSurface)) return { accepted: false, reason: "numeric" };
  if (includesTimestampFragment(baseSurface)) return { accepted: false, reason: "timestamp_fragment" };

  let label = String(candidate.label ?? "").toUpperCase() as EntityMentionLabel;
  if (!label) return { accepted: false, reason: "bad_type" };
  const supportedLabels: EntityMentionLabel[] = [
    "PERSON",
    "ORG",
    "SERVICE",
    "TOOL",
    "MODEL",
    "PROJECT",
    "AGENT",
    "ROLE",
    "PRODUCT",
    "LOCATION",
  ];
  if (!supportedLabels.includes(label)) {
    if (MODEL_MATCHER.test(baseSurface)) {
      label = "MODEL";
    } else {
      return { accepted: false, reason: "bad_type" };
    }
  }

  let normalizedSurface = normalizeEntityKey(candidate.normalizedSurface?.trim() || baseSurface);
  if (!normalizedSurface) return { accepted: false, reason: "short" };
  if (GENERIC_TERMS.has(normalizedSurface)) return { accepted: false, reason: "generic_term" };
  if (label === "PERSON" && /^(surgeon|forge|scholar|council|agent|assistant)$/i.test(normalizedSurface)) {
    return { accepted: false, reason: "role_person" };
  }

  if (acronymType) {
    label = acronymType;
  }

  const canonical = canonicalizeByKnownMap(baseSurface, normalizedSurface, label);
  label = canonical.label;
  normalizedSurface = canonical.normalizedSurface || normalizedSurface;

  const confidence = Number.isFinite(candidate.confidence)
    ? Math.max(0, Math.min(Number(candidate.confidence), 1))
    : 0.75;
  if (confidence < minConfidenceForLabel(label)) return { accepted: false, reason: "low_confidence" };

  return {
    accepted: true,
    label,
    surfaceText: baseSurface,
    normalizedSurface,
    confidence,
  };
}
