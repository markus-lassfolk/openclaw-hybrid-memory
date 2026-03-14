/**
 * ACP provenance utilities for council reviews (Issue #280).
 *
 * Council reviews are orchestrated externally by the main agent (not by this plugin).
 * This module provides helpers so orchestrators can include provenance metadata in:
 *   - ACP session spawn calls (X-Trace-Id, X-Council-Member, X-Session-Key headers)
 *   - GitHub PR review comments (trace ID in comment body)
 *
 * Usage in an orchestration agent:
 *   import { getProvenanceHeaders, formatProvenanceReceipt } from ".../utils/provenance.js";
 *   const headers = getProvenanceHeaders(sessionKey, { councilMember: "🔮 Gemini" });
 *   // Pass headers to sessions_spawn, and append formatProvenanceReceipt(...) to the review body.
 */

import { randomBytes } from "node:crypto";
import type { CouncilProvenanceMode } from "../config/types/maintenance.js";

/**
 * ACP provenance headers for a council review session spawn.
 *
 * Standard fields:
 *   - X-Trace-Id: unique identifier for this council review run (shared across all members)
 *   - X-Council-Member: name/label of this reviewer (e.g. "Gemini Architect")
 *   - X-Session-Key: the derived session key for this council member session
 *   - X-Parent-Session: the orchestrator session that spawned this review
 */
export type ProvenanceHeaders = Record<string, string>;

/**
 * Generate ACP provenance headers for a council member session.
 *
 * @param sessionKey  Unique key for this council member session (e.g. "council-review-abc123")
 * @param opts        Optional metadata to include in headers
 * @returns           Map of header name → value; pass to sessions_spawn or embed in comments
 *
 * @example
 *   const headers = getProvenanceHeaders("council-review-pr-283", {
 *     councilMember: "🔮 Gemini Architect",
 *     traceId: sharedTraceId,
 *     parentSession: "main",
 *   });
 */
export function getProvenanceHeaders(
  sessionKey: string,
  opts: {
    councilMember?: string;
    traceId?: string;
    parentSession?: string;
  } = {},
): ProvenanceHeaders {
  const traceId = opts.traceId ?? generateTraceId();
  const headers: ProvenanceHeaders = {
    "X-Trace-Id": traceId,
    "X-Session-Key": sessionKey,
  };
  if (opts.councilMember) {
    headers["X-Council-Member"] = opts.councilMember;
  }
  if (opts.parentSession) {
    headers["X-Parent-Session"] = opts.parentSession;
  }
  return headers;
}

/**
 * Format a provenance receipt to append to a GitHub PR review comment.
 * This creates a traceable audit trail linking the GitHub comment to the ACP session.
 *
 * @param traceId    The trace ID from getProvenanceHeaders (or a shared run ID)
 * @param sessionKey The council member session key
 * @returns          Markdown string to append to the review body
 *
 * @example
 *   const receipt = formatProvenanceReceipt("trace-abc123", "council-review-pr-283");
 *   // Append to review body: body + "\n\n" + receipt
 */
export function formatProvenanceReceipt(traceId: string, sessionKey: string): string {
  const ts = new Date().toISOString();
  return `---\n*Provenance: trace-id=${traceId} session=${sessionKey} at=${ts}*`;
}

/**
 * Build provenance metadata based on the configured mode.
 *
 * @param mode        Council provenance mode from config (default: "meta+receipt")
 * @param sessionKey  Council member session key
 * @param opts        Optional: councilMember name, parentSession, shared traceId
 * @returns           { headers, receipt } — headers for ACP spawn, receipt for GitHub comments
 *                    Either may be null depending on mode.
 */
export function buildProvenanceMetadata(
  mode: CouncilProvenanceMode,
  sessionKey: string,
  opts: {
    councilMember?: string;
    traceId?: string;
    parentSession?: string;
  } = {},
): { headers: ProvenanceHeaders | null; receipt: string | null } {
  if (mode === "none") {
    return { headers: null, receipt: null };
  }

  const traceId = opts.traceId ?? generateTraceId();

  const headers: ProvenanceHeaders | null =
    mode === "meta" || mode === "meta+receipt" ? getProvenanceHeaders(sessionKey, { ...opts, traceId }) : null;

  const receipt: string | null =
    mode === "receipt" || mode === "meta+receipt" ? formatProvenanceReceipt(traceId, sessionKey) : null;

  return { headers, receipt };
}

/**
 * Generate a unique trace ID for a council review run.
 * Format: "trace-<8 hex chars>" — short enough to include in comments, unique enough for audit.
 */
export function generateTraceId(): string {
  return `trace-${randomBytes(4).toString("hex")}`;
}

/**
 * Build a council session key from a prefix and optional PR/run identifier.
 *
 * @param prefix  Session key prefix from config (e.g. "council-review")
 * @param suffix  Optional suffix (e.g. PR number "283" or short hash)
 * @returns       Combined session key (e.g. "council-review-283" or "council-review-a1b2c3d4")
 */
export function buildCouncilSessionKey(prefix: string, suffix?: string): string {
  const s = suffix?.trim() || randomBytes(4).toString("hex");
  return `${prefix}-${s}`;
}
