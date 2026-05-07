/**
 * Decay classification and TTL for facts.
 * Uses language-keywords for text patterns (English + dynamic languages from .language-keywords.json).
 */

import type { DecayClass } from "../config.js";
import { TTL_DEFAULTS } from "../config.js";
import {
  getDecayActiveKeys,
  getDecayActiveRegex,
  getDecayCheckpointKeys,
  getDecayPermanentEntities,
  getDecayPermanentKeys,
  getDecayPermanentRegex,
  getDecaySessionKeys,
  getDecaySessionRegex,
} from "./language-keywords.js";

export function calculateExpiry(decayClass: DecayClass, fromTimestamp = Math.floor(Date.now() / 1000)): number | null {
  const ttl = TTL_DEFAULTS[decayClass];
  return ttl ? fromTimestamp + ttl : null;
}

export type DecayClassificationContext = {
  source?: string | null;
  category?: string | null;
  importance?: number | null;
};

function categoryIn(category: string, values: readonly string[]): boolean {
  return values.includes(category.toLowerCase());
}

export function classifyDecay(
  entity: string | null,
  key: string | null,
  _value: string | null,
  text: string,
  context: DecayClassificationContext = {},
): DecayClass {
  const keyLower = (key || "").toLowerCase();
  const textLower = text.toLowerCase();
  const entityLower = (entity || "").toLowerCase();
  const sourceLower = (context.source || "").toLowerCase();
  const categoryLower = (context.category || "").toLowerCase();
  const importance = context.importance ?? null;

  if (/^(?:pr|pull request|issue)\s*#?\d+$/i.test(entity || "")) return "normal";
  if (/^sprint\b/i.test(entity || "")) return "normal";

  if (getDecayPermanentKeys().some((k) => keyLower.includes(k))) return "permanent";
  if (getDecayPermanentRegex().test(textLower)) return "permanent";
  if (entityLower && getDecayPermanentEntities().some((e) => entityLower === e)) return "permanent";

  if (getDecaySessionKeys().some((k) => keyLower.includes(k))) return "session";
  if (getDecaySessionRegex().test(textLower)) return "session";

  if (getDecayActiveKeys().some((k) => keyLower.includes(k))) return "active";
  if (getDecayActiveRegex().test(textLower)) return "active";

  if (getDecayCheckpointKeys().some((k) => keyLower.includes(k))) return "checkpoint";
  if (sourceLower === "dream-cycle-src") return "checkpoint";

  if (sourceLower === "auto-capture" || sourceLower === "implicit-feedback") return "normal";
  if (sourceLower === "distillation") {
    return categoryIn(categoryLower, ["rule", "edict", "preference", "decision"]) ? "durable" : "normal";
  }
  if (sourceLower.startsWith("seed:")) {
    return categoryIn(categoryLower, ["rule", "edict", "fact"]) ? "permanent" : "durable";
  }

  if (categoryIn(categoryLower, ["rule", "edict"])) return "permanent";
  if (categoryIn(categoryLower, ["preference", "decision"])) return "durable";
  if (categoryIn(categoryLower, ["pattern", "coding_task", "monitoring"])) return "short";

  if (importance != null) {
    if (importance >= 0.8) return "stable";
    if (importance < 0.4) return "short";
  }

  return "normal";
}
