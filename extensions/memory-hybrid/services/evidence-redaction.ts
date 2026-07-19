/**
 * Evidence capsule redaction (#2148 acceptance criterion: "Tests verify secret-like
 * values are redacted or rejected"). Runs the shared autopilot redactor (API keys,
 * password/token/secret-labeled values, Bearer tokens, userinfo URLs, PEM private-key
 * blocks) over every free-text field of a capsule.
 */

import type { CreateEvidenceCapsuleInput, EvidenceArtifact, EvidenceItem } from "../types/evidence-types.js";
import { redactAutopilotText } from "./pending-autopilot/index.js";

/** A PEM-style private-key marker literally surviving redaction means the automatic
 *  stripper could not fully remove it (e.g. block exceeds its max-length cap) — a
 *  narrow, safe "still unredacted" signal that never false-positives on ordinary
 *  evidence text (commit SHAs, UUIDs, file hashes). */
const UNSTRIPPED_PRIVATE_KEY_MARKER = /-----BEGIN [^-]*PRIVATE KEY-----/;

export class EvidenceUnredactableError extends Error {
  constructor(readonly field: string) {
    super(`Evidence capsule field "${field}" still contains a secret-like value after redaction.`);
    this.name = "EvidenceUnredactableError";
  }
}

function redactField(text: string, field: string, rejectUnredactable: boolean): { text: string; count: number } {
  const { redacted, redactionCount } = redactAutopilotText(text);
  if (rejectUnredactable && UNSTRIPPED_PRIVATE_KEY_MARKER.test(redacted)) {
    throw new EvidenceUnredactableError(field);
  }
  return { text: redacted, count: redactionCount };
}

export interface RedactedEvidenceContent {
  title: string;
  claim: string;
  evidence: EvidenceItem[];
  commandsRun: string[];
  artifacts: EvidenceArtifact[];
  unverifiedItems: string[];
  riskFlags: string[];
  limits: string | undefined;
  redactionCount: number;
  redacted: boolean;
}

/**
 * Redact every free-text field of a capsule input. Throws {@link EvidenceUnredactableError}
 * when `rejectUnredactable` is true and a field still looks secret-bearing after redaction.
 */
export function redactEvidenceCapsuleInput(
  input: CreateEvidenceCapsuleInput,
  opts: { redactSecrets: boolean; rejectUnredactable: boolean },
): RedactedEvidenceContent {
  let totalCount = 0;
  const apply = (text: string, field: string): string => {
    if (!opts.redactSecrets) return text;
    const { text: redacted, count } = redactField(text, field, opts.rejectUnredactable);
    totalCount += count;
    return redacted;
  };

  const evidence = (input.evidence ?? []).map((item, i) => ({
    ...item,
    text: apply(item.text, `evidence[${i}]`),
  }));
  const artifacts = (input.artifacts ?? []).map((a, i) => ({
    ...a,
    description: a.description !== undefined ? apply(a.description, `artifacts[${i}].description`) : a.description,
  }));

  return {
    title: apply(input.title, "title"),
    claim: apply(input.claim, "claim"),
    evidence,
    commandsRun: (input.commandsRun ?? []).map((c, i) => apply(c, `commandsRun[${i}]`)),
    artifacts,
    unverifiedItems: (input.unverifiedItems ?? []).map((u, i) => apply(u, `unverifiedItems[${i}]`)),
    riskFlags: input.riskFlags ?? [],
    limits: input.limits !== undefined ? apply(input.limits, "limits") : undefined,
    redactionCount: totalCount,
    redacted: totalCount > 0,
  };
}
