/** Render an evidence capsule as prompt-safe Markdown (#2148) — concise final-report form or full audit form. */
import type { EvidenceCapsule } from "../types/evidence-types.js";

export function renderEvidenceCapsuleMarkdown(capsule: EvidenceCapsule, opts: { concise: boolean }): string {
  const lines: string[] = [];
  lines.push(`### Evidence capsule ${capsule.id.slice(0, 8)}: ${capsule.title}`);
  lines.push(`**Claim:** ${capsule.claim}`);
  lines.push(`**Created:** ${capsule.createdAt}${capsule.actor ? ` by ${capsule.actor}` : ""}`);
  if (capsule.redactionStatus === "redacted") {
    lines.push(`**Redaction:** ${capsule.redactionCount} value(s) redacted before storage.`);
  }
  if (capsule.verifiedAt) lines.push(`**Verified:** ${capsule.verifiedAt}`);

  if (capsule.evidence.length > 0) {
    lines.push("", "**Evidence:**");
    for (const e of capsule.evidence) lines.push(`- [${e.kind}] ${e.text}`);
  }
  if (!opts.concise) {
    if (capsule.commandsRun.length > 0) {
      lines.push("", "**Commands run:**");
      for (const c of capsule.commandsRun) lines.push(`- \`${c}\``);
    }
    if (capsule.artifacts.length > 0) {
      lines.push("", "**Artifacts:**");
      for (const a of capsule.artifacts) lines.push(`- ${a.path}${a.description ? ` — ${a.description}` : ""}`);
    }
  }
  if (capsule.unverifiedItems.length > 0) {
    lines.push("", "**Unverified:**");
    for (const u of capsule.unverifiedItems) lines.push(`- ${u}`);
  }
  if (capsule.riskFlags.length > 0) {
    lines.push("", `**Risk flags:** ${capsule.riskFlags.join(", ")}`);
  }
  if (capsule.limits) lines.push("", `**Limits:** ${capsule.limits}`);
  if (capsule.linkedClaimIds.length > 0) {
    lines.push("", `**Linked claims:** ${capsule.linkedClaimIds.map((c) => c.slice(0, 8)).join(", ")}`);
  }
  return lines.join("\n");
}
