/**
 * Decay classification and TTL for facts.
 */

import type { DecayClass } from "../config.js";
import { TTL_DEFAULTS } from "../config.js";

export function calculateExpiry(
  decayClass: DecayClass,
  fromTimestamp = Math.floor(Date.now() / 1000),
): number | null {
  const ttl = TTL_DEFAULTS[decayClass];
  return ttl ? fromTimestamp + ttl : null;
}

export function classifyDecay(
  entity: string | null,
  key: string | null,
  value: string | null,
  text: string,
): DecayClass {
  const keyLower = (key || "").toLowerCase();
  const textLower = text.toLowerCase();

  const permanentKeys = [
    "name", "email", "api_key", "api_endpoint", "architecture",
    "decision", "birthday", "born", "phone", "language", "location",
  ];
  if (permanentKeys.some((k) => keyLower.includes(k))) return "permanent";
  if (/\b(decided|architecture|always use|never use|bestämde|valde|alltid använda|aldrig använda)\b/i.test(textLower))
    return "permanent";

  if (entity === "decision" || entity === "convention") return "permanent";

  const sessionKeys = ["current_file", "temp", "debug", "working_on_right_now"];
  if (sessionKeys.some((k) => keyLower.includes(k))) return "session";
  if (/\b(currently debugging|right now|this session|just nu|denna session)\b/i.test(textLower))
    return "session";

  const activeKeys = ["task", "todo", "wip", "branch", "sprint", "blocker"];
  if (activeKeys.some((k) => keyLower.includes(k))) return "active";
  if (/\b(working on|need to|todo|blocker|sprint|behöver|just nu)\b/i.test(textLower))
    return "active";

  if (keyLower.includes("checkpoint") || keyLower.includes("preflight"))
    return "checkpoint";

  return "stable";
}
