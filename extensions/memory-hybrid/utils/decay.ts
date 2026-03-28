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

export function classifyDecay(
  entity: string | null,
  key: string | null,
  _value: string | null,
  text: string,
): DecayClass {
  const keyLower = (key || "").toLowerCase();
  const textLower = text.toLowerCase();
  const entityLower = (entity || "").toLowerCase();

  if (getDecayPermanentKeys().some((k) => keyLower.includes(k))) return "permanent";
  if (getDecayPermanentRegex().test(textLower)) return "permanent";
  if (entityLower && getDecayPermanentEntities().some((e) => entityLower === e)) return "permanent";

  if (getDecaySessionKeys().some((k) => keyLower.includes(k))) return "session";
  if (getDecaySessionRegex().test(textLower)) return "session";

  if (getDecayActiveKeys().some((k) => keyLower.includes(k))) return "active";
  if (getDecayActiveRegex().test(textLower)) return "active";

  if (getDecayCheckpointKeys().some((k) => keyLower.includes(k))) return "checkpoint";

  return "stable";
}
