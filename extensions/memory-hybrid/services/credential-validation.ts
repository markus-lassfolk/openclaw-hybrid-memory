/**
 * Credential value and service name validation.
 * Used to reject narrative text, paths, and descriptions from being stored as secrets.
 */

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** Minimum length for a credential value to be considered valid. */
export const MIN_CREDENTIAL_VALUE_LENGTH = 8;

/**
 * Pattern: value looks like a filesystem path (no auth part).
 * Catches absolute paths (starting with /) and home-relative paths (starting with ~).
 */
function looksLikePath(value: string): boolean {
  // Tilde-home or absolute path
  if (/^[/~]/.test(value)) {
    if (/@|:\/\//.test(value)) return false; // URL with auth — not a bare path
    return true;
  }
  if (!value.includes("/")) return false;
  if (/@|:\/\//.test(value)) return false;
  if (/^[\w.-]+\//.test(value) && value.length > 6) return true;
  return false;
}

/**
 * Pattern: value looks like natural-language text rather than a secret.
 * Uses a language-agnostic heuristic: text longer than 25 characters with
 * more than 3 whitespace tokens and no characters typical of encoded credentials
 * (=, +, /, _, @).  This works across non-English languages unlike English
 * word-list approaches.
 */
function looksLikeNaturalLanguage(value: string): boolean {
  const spaceTokens = (value.match(/\s+/g) ?? []).length;
  const hasCredChars = /[=+/_@]/.test(value);
  if (value.length > 25 && spaceTokens > 3 && !hasCredChars) return true;
  return false;
}

/**
 * Validate that a credential value looks like an actual secret.
 *
 * `hasPatternMatch` should be `true` only when the `value` being validated
 * was itself extracted by a credential regex (e.g. a JWT, sk-…, ghp_…).
 * When the value comes from a structured parameter while the pattern matched
 * elsewhere in the text, callers MUST pass `false` so that natural-language
 * and path checks are applied — preventing narrative text from being stored
 * as a credential even when a recognisable token appeared nearby.
 *
 * Callers in `auto-capture.ts` apply this correctly via `secretFromParam` logic.
 */
export function validateCredentialValue(
  value: string,
  type: string,
  hasPatternMatch: boolean,
): ValidationResult {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  // "other" type without a pattern match is held to a stricter minimum (12 chars).
  // This check runs before the general MIN to produce the more-specific reason code.
  if (!hasPatternMatch && trimmed.length < 12 && type === "other") {
    return { ok: false, reason: "value_too_short_for_other" };
  }

  // General minimum length — always applies even when a pattern matched.
  if (trimmed.length < MIN_CREDENTIAL_VALUE_LENGTH) return { ok: false, reason: "value_too_short" };

  // Content checks only run when the value did NOT come from a direct pattern match,
  // because pattern-matched values can legitimately be passphrases with spaces.
  if (!hasPatternMatch) {
    if (looksLikeNaturalLanguage(trimmed)) return { ok: false, reason: "natural_language" };
    if (looksLikePath(trimmed)) return { ok: false, reason: "path" };
  }

  return { ok: true };
}

/** Max length for service name (reject longer). */
export const CREDENTIAL_SERVICE_MAX_LENGTH = 50;
/** Alias for CREDENTIAL_SERVICE_MAX_LENGTH — consistent with credential-scanner naming. */
export const MAX_SERVICE_NAME_LENGTH = CREDENTIAL_SERVICE_MAX_LENGTH;

/** Max number of dash-separated tokens in service slug (sentence-like). */
export const CREDENTIAL_SERVICE_MAX_TOKENS = 6;

/** Known service name variants -> canonical name (for dedup). */
const SERVICE_NORMALIZE_MAP: Record<string, string> = {
  anthropic_api_key: "anthropic",
  anthropic: "anthropic",
  glitchtip_api_token: "glitchtip",
  glitchtip_api_key: "glitchtip",
  glitchtip: "glitchtip",
  openai: "openai",
  github: "github",
  minimax_generic: "minimax",
  minimax: "minimax",
  home_assistant: "home-assistant",
  "home-assistant": "home-assistant",
};

/**
 * Validate and normalize service name for vault storage.
 * Returns null if the service name should be rejected.
 * Otherwise returns a validated slug, or a canonical name from the normalization map.
 * URL-style names (containing "://") and hostnames (containing ".") are only length-checked, not slugified.
 */
export function validateAndNormalizeServiceName(serviceSlug: string): string | null {
  const trimmed = serviceSlug.trim();
  if (!trimmed) return "imported";

  if (trimmed.includes("://")) {
    if (trimmed.length > CREDENTIAL_SERVICE_MAX_LENGTH) return null;
    return trimmed.toLowerCase();
  }
  if (trimmed.includes(".")) {
    if (trimmed.length > CREDENTIAL_SERVICE_MAX_LENGTH) return null;
    return trimmed.toLowerCase();
  }

  const slug = trimmed.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "") || "imported";
  if (slug === "imported") return slug;
  if (slug.length > CREDENTIAL_SERVICE_MAX_LENGTH) return null;
  const tokens = slug.split("-").filter(Boolean);
  if (tokens.length > CREDENTIAL_SERVICE_MAX_TOKENS) return null;
  return SERVICE_NORMALIZE_MAP[slug] ?? slug;
}

/**
 * Normalize service name to a canonical form for deduplication.
 * Mirrors validateAndNormalizeServiceName: preserves dots for hostname-style services
 * and :// for URL-style services so that the dedup canonical form matches what is
 * actually stored in the vault.
 * Does not reject; use validateAndNormalizeServiceName for rejection.
 */
export function normalizeServiceForDedup(serviceSlug: string): string {
  // URL-style (contains ://) — preserve as-is after lower-casing
  if (serviceSlug.includes("://")) {
    const lower = serviceSlug.toLowerCase();
    return SERVICE_NORMALIZE_MAP[lower] ?? lower;
  }
  // Hostname-style (contains dot) — preserve dots, only lower-case
  if (serviceSlug.includes(".")) {
    const lower = serviceSlug.toLowerCase();
    return SERVICE_NORMALIZE_MAP[lower] ?? lower;
  }
  const key = serviceSlug.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "") || "imported";
  return SERVICE_NORMALIZE_MAP[key] ?? key;
}

/**
 * Return audit flags for a credential value (for CLI audit). Uses same heuristics as validateCredentialValue.
 */
export function auditCredentialValue(value: string, type: string): string[] {
  const flags: string[] = [];
  const trimmed = value.trim();
  if (!trimmed) {
    flags.push("empty");
    return flags;
  }
  if (trimmed.length < MIN_CREDENTIAL_VALUE_LENGTH) flags.push("value_too_short");
  if (trimmed.length < 12 && type === "other") flags.push("value_too_short_for_other");
  if (looksLikeNaturalLanguage(trimmed)) flags.push("natural_language");
  if (looksLikePath(trimmed)) flags.push("path");
  return flags;
}

/**
 * Return audit flags for a service name (for CLI audit).
 */
export function auditServiceName(service: string): string[] {
  const flags: string[] = [];
  if (service.length > CREDENTIAL_SERVICE_MAX_LENGTH) flags.push("service_too_long");
  if (!service.includes("://")) {
    const tokens = service.split("-").filter(Boolean);
    if (tokens.length > CREDENTIAL_SERVICE_MAX_TOKENS) flags.push("service_sentence_like");
  }
  return flags;
}
