/**
 * Credential value and service name validation.
 * Used to reject narrative text, paths, and descriptions from being stored as secrets.
 */

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** Common words that suggest natural language rather than a secret. */
const SENTENCE_WORDS =
  /\b(the|is|are|was|were|requires|explicit|login|via|token|credentials|identified|stored|password|host|gateway|note|fix|user|model|even|if|form|rejects|without|verified|email)\b/i;

/** Pattern: value looks like a sentence (multiple spaces + common words). */
function looksLikeNaturalLanguage(value: string): boolean {
  if (value.trim().split(/\s+/).length < 2) return false;
  if (SENTENCE_WORDS.test(value) && /[a-z]/.test(value)) return true;
  if (/\b(requires|explicit|login|via|token is)\b/i.test(value)) return true;
  return false;
}

/** Pattern: value looks like a filesystem path (no auth part). */
function looksLikePath(value: string): boolean {
  if (!value.includes("/")) return false;
  if (/@|:\/\//.test(value)) return false;
  if (/^[\/\w.-]+$/.test(value) && value.length > 6) return true;
  return false;
}

/** Pattern: long descriptive text about credentials. */
function looksLikeDescription(value: string): boolean {
  if (value.length < 80) return false;
  if (/\b(credentials|ident|stored|password)\b/i.test(value) && /[a-z]{4,}/.test(value)) return true;
  return false;
}

/**
 * Validate that a credential value looks like an actual secret.
 * When hasPatternMatch is true (e.g. JWT, sk-, ghp_), we are more permissive.
 */
export function validateCredentialValue(
  value: string,
  type: string,
  hasPatternMatch: boolean,
): ValidationResult {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  if (!hasPatternMatch) {
    if (trimmed.length < 12 && type === "other") return { ok: false, reason: "value_too_short_for_other" };
    if (looksLikeNaturalLanguage(trimmed)) return { ok: false, reason: "natural_language" };
    if (looksLikePath(trimmed)) return { ok: false, reason: "path" };
    if (looksLikeDescription(trimmed)) return { ok: false, reason: "description" };
  }

  if (trimmed.length < 8) return { ok: false, reason: "value_too_short" };
  return { ok: true };
}

/** Max length for service name (reject longer). */
export const CREDENTIAL_SERVICE_MAX_LENGTH = 50;

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
    return trimmed;
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
 * Does not reject; use validateAndNormalizeServiceName for rejection.
 */
export function normalizeServiceForDedup(serviceSlug: string): string {
  const key = serviceSlug.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
  return SERVICE_NORMALIZE_MAP[key] ?? key;
}

/** Minimal credentials DB interface for dedup check (avoids importing CredentialsDB). */
export type CredentialsDbLike = {
  get(service: string, type?: "token" | "password" | "api_key" | "ssh" | "bearer" | "other"): { value: string } | null;
};

/**
 * Return true if the vault already has the same (service, type) with the same value (no-op store).
 * Use before store in auto-capture paths to avoid redundant writes.
 */
export function shouldSkipCredentialStore(
  db: CredentialsDbLike,
  entry: { service: string; type: "token" | "password" | "api_key" | "ssh" | "bearer" | "other"; value: string },
): boolean {
  const existing = db.get(entry.service, entry.type);
  return existing !== null && existing.value === entry.value;
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
  if (trimmed.length < 8) flags.push("value_too_short");
  if (trimmed.length < 12 && type === "other") flags.push("value_too_short_for_other");
  if (looksLikeNaturalLanguage(trimmed)) flags.push("natural_language");
  if (looksLikePath(trimmed)) flags.push("path");
  if (looksLikeDescription(trimmed)) flags.push("description");
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
