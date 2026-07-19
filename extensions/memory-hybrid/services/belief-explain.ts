/** Render a claim's belief-graph explanation as prompt-safe Markdown (#2151). */
import type { Claim, LiveCheckStatus } from "../types/belief-types.js";

export function renderClaimExplainMarkdown(claim: Claim, liveCheck: LiveCheckStatus): string {
  const lines: string[] = [];
  lines.push(`Claim: ${claim.entity} ${claim.predicate} = ${claim.value}`);
  lines.push(`Status: ${claim.status}`);
  lines.push(`Confidence: ${claim.confidence}`);
  if (claim.evidenceCapsuleIds.length > 0) {
    lines.push(`Evidence: ${claim.evidenceCapsuleIds.map((c) => `capsule ${c.slice(0, 8)}`).join(", ")}`);
  }
  if (claim.sourceFactIds.length > 0) {
    lines.push(`Source facts: ${claim.sourceFactIds.map((f) => f.slice(0, 8)).join(", ")}`);
  }
  if (claim.lastVerifiedAt) lines.push(`Last verified: ${claim.lastVerifiedAt}`);
  if (claim.why) lines.push(`Why: ${claim.why}`);
  if (claim.invalidationConditions.length > 0) {
    lines.push(`Invalidation: ${claim.invalidationConditions.join(", ")}`);
  }
  if (claim.contradictsClaimIds.length > 0) {
    lines.push(`Contradicts: ${claim.contradictsClaimIds.map((c) => c.slice(0, 8)).join(", ")}`);
  }
  if (claim.supersededByClaimId) lines.push(`Superseded by: ${claim.supersededByClaimId.slice(0, 8)}`);
  lines.push(
    `Live-check before action: ${claim.liveCheckRequired ? `yes${claim.liveCheckReason ? ` — ${claim.liveCheckReason}` : ""} (${liveCheck.state})` : "no"}`,
  );
  return lines.join("\n");
}
