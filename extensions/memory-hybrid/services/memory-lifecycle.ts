/**
 * Memory lifecycle workflows — forgetting, demotion, and archival (Issue #2155).
 * Report-only by default. Demotion/archive preserve provenance (tag + audit entry,
 * no data loss); deletion/quarantine require an explicit reason and are audited.
 */
import { addTag, getContradictions, isFactVerified } from "../backends/facts-db/contradictions.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { LoomStore } from "../backends/loom-store.js";
import type {
  LifecycleAction,
  LifecycleAuditEntry,
  LifecycleCandidate,
  LifecycleCandidateReason,
  LifecycleCandidatesOptions,
  LifecycleCandidatesReport,
  LifecycleUpdateInput,
} from "../types/lifecycle-workflow-types.js";
import { normalizedHash } from "../utils/tags.js";

export const LIFECYCLE_DEMOTED_TAG = "lifecycle-demoted";
export const LIFECYCLE_ARCHIVED_TAG = "lifecycle-archived";
export const LIFECYCLE_QUARANTINED_TAG = "lifecycle-quarantined";

/** Naive but real prompt-injection heuristic: classic override phrasing pasted verbatim into memory. */
const PROMPT_INJECTION_MARKERS =
  /\bignore\s+(all\s+|your\s+)?(previous|prior|the above|earlier)?\s*instructions\b|\bdisregard\s+(all\s+|your\s+)?(previous|prior)?\s*(instructions|prompts)\b|\byou are now (in )?developer mode\b|\bnew system prompt\b/i;

export interface MemoryLifecycleDeps {
  factsDb: FactsDB;
  loomStore: LoomStore;
}

export function listLifecycleCandidates(
  deps: MemoryLifecycleDeps,
  opts: LifecycleCandidatesOptions = {},
): LifecycleCandidatesReport {
  const { factsDb } = deps;
  const targetKinds = opts.targetKinds ?? ["fact"];
  const candidates: LifecycleCandidate[] = [];

  if (targetKinds.includes("fact")) {
    const db = factsDb.getRawDb();
    const facts = factsDb.getAll({ includeSuperseded: true });
    const byNormalizedText = new Map<string, Array<{ id: string; createdAt: number }>>();

    const contradictedIds = new Set(
      getContradictions(db, undefined, 500)
        .filter((c) => !c.resolved)
        .flatMap((c) => [c.factIdOld, c.factIdNew]),
    );

    const nowSec = Math.floor(Date.now() / 1000);
    for (const fact of facts) {
      const reasons: LifecycleCandidateReason[] = [];
      const isVerified = isFactVerified(db, fact.id);
      const isCritical =
        isVerified || (fact.importance ?? 0.5) >= 0.85 || Boolean((fact as { pinnedAt?: number }).pinnedAt);

      if (fact.supersededAt) reasons.push("superseded");
      if (contradictedIds.has(fact.id)) reasons.push("contradicted");
      if (PROMPT_INJECTION_MARKERS.test(fact.text)) reasons.push("prompt_injection_like");

      const hash = normalizedHash(fact.text);
      const group = byNormalizedText.get(hash) ?? [];
      group.push({ id: fact.id, createdAt: fact.createdAt });
      byNormalizedText.set(hash, group);

      const staleAfterSec = (opts as { staleAfterDays?: number }).staleAfterDays
        ? (opts as { staleAfterDays: number }).staleAfterDays * 86_400
        : 45 * 86_400;
      const lastTouched = fact.lastConfirmedAt ?? fact.createdAt ?? 0;
      if (!isCritical && (fact.importance ?? 0.5) < 0.4 && nowSec - lastTouched > staleAfterSec) {
        reasons.push("stale_low_access");
      }

      if (reasons.length === 0) continue;
      candidates.push({
        targetKind: "fact",
        targetId: fact.id,
        label: fact.text.slice(0, 100),
        reasons,
        explanation: explainReasons(reasons),
        suggestedAction: suggestedActionFor(reasons, isCritical),
        isVerifiedOrCritical: isCritical,
      });
    }

    // Second pass: exact-duplicate normalized text — the oldest copy is the "original"; every
    // newer copy (by createdAt, so this is deterministic regardless of UUID ordering) is the candidate.
    for (const [, entries] of byNormalizedText) {
      if (entries.length < 2) continue;
      const sorted = [...entries].sort((a, b) => a.createdAt - b.createdAt);
      for (const dup of sorted.slice(1)) {
        const dupId = dup.id;
        const existing = candidates.find((c) => c.targetId === dupId);
        if (existing) {
          if (!existing.reasons.includes("duplicate")) existing.reasons.push("duplicate");
        } else {
          candidates.push({
            targetKind: "fact",
            targetId: dupId,
            label: "(duplicate text)",
            reasons: ["duplicate"],
            explanation: "Exact-duplicate text of another fact.",
            suggestedAction: "archive",
            isVerifiedOrCritical: false,
          });
        }
      }
    }
  }

  const limited = opts.limit && opts.limit > 0 ? candidates.slice(0, opts.limit) : candidates;
  return { generatedAt: new Date().toISOString(), candidates: limited, totalConsidered: candidates.length };
}

function explainReasons(reasons: LifecycleCandidateReason[]): string {
  const parts: string[] = [];
  if (reasons.includes("contradicted")) parts.push("contradicted by a newer verified fact");
  if (reasons.includes("superseded")) parts.push("already marked superseded");
  if (reasons.includes("duplicate")) parts.push("duplicate of another fact");
  if (reasons.includes("stale_low_access")) parts.push("stale and low operational importance");
  if (reasons.includes("prompt_injection_like")) parts.push("contains prompt-injection-like phrasing");
  return parts.join("; ") || "flagged by lifecycle scan";
}

function suggestedActionFor(reasons: LifecycleCandidateReason[], isCritical: boolean): LifecycleAction {
  if (reasons.includes("prompt_injection_like")) return "quarantine";
  if (isCritical) return "demote";
  if (reasons.includes("contradicted") || reasons.includes("duplicate") || reasons.includes("superseded"))
    return "archive";
  return "demote";
}

export class LifecycleStrongConfirmRequiredError extends Error {
  constructor() {
    super("This fact is verified/critical — deletion requires a strong confirmation token (strongConfirm).");
    this.name = "LifecycleStrongConfirmRequiredError";
  }
}

export class LifecycleConfirmRequiredError extends Error {
  constructor(action: LifecycleAction) {
    super(`Action "${action}" is destructive — pass confirm: true and a reason.`);
    this.name = "LifecycleConfirmRequiredError";
  }
}

const STRONG_CONFIRM_TOKEN = "DELETE-VERIFIED";

export function applyLifecycleAction(
  deps: MemoryLifecycleDeps,
  input: LifecycleUpdateInput,
  cfg: { requireStrongConfirmForVerified: boolean },
): { ok: boolean; message: string; audit: LifecycleAuditEntry } {
  const { factsDb, loomStore } = deps;
  if ((input.action === "delete" || input.action === "quarantine") && !input.confirm) {
    throw new LifecycleConfirmRequiredError(input.action);
  }

  if (input.targetKind !== "fact") {
    throw new Error(`Lifecycle action on target kind "${input.targetKind}" is not yet supported — only "fact" is.`);
  }

  const db = factsDb.getRawDb();
  const row = db.prepare("SELECT id, text FROM facts WHERE id = ?").get(input.targetId) as
    | { id: string; text: string }
    | undefined;
  if (!row) throw new Error(`Fact not found: ${input.targetId}`);

  const isVerified = isFactVerified(db, input.targetId);
  if (input.action === "delete" && isVerified && cfg.requireStrongConfirmForVerified) {
    if (input.strongConfirm !== STRONG_CONFIRM_TOKEN) throw new LifecycleStrongConfirmRequiredError();
  }

  let message: string;
  switch (input.action) {
    case "demote":
      factsDb.boostConfidence(input.targetId, -0.3, 1.0);
      addTag(db, input.targetId, LIFECYCLE_DEMOTED_TAG);
      message = `Demoted fact ${input.targetId} (confidence lowered, tagged ${LIFECYCLE_DEMOTED_TAG}).`;
      break;
    case "archive":
      addTag(db, input.targetId, LIFECYCLE_ARCHIVED_TAG);
      message = `Archived fact ${input.targetId} (tagged ${LIFECYCLE_ARCHIVED_TAG}; still searchable as historical context).`;
      break;
    case "quarantine": {
      const quarantinedText = `[quarantined: ${input.reason}]`;
      db.prepare("UPDATE facts SET text = ? WHERE id = ?").run(quarantinedText, input.targetId);
      addTag(db, input.targetId, LIFECYCLE_QUARANTINED_TAG);
      message = `Quarantined fact ${input.targetId} (content replaced, original preserved only in the audit log).`;
      break;
    }
    case "delete":
      factsDb.delete(input.targetId);
      message = `Deleted fact ${input.targetId}.`;
      break;
  }

  const audit = loomStore.recordLifecycleAudit({
    targetKind: input.targetKind,
    targetId: input.targetId,
    action: input.action,
    reason: input.reason,
    confirmedBy: input.confirmedBy,
    metadata: input.action === "quarantine" ? { originalTextPreview: row.text.slice(0, 200) } : {},
  });

  return { ok: true, message, audit };
}
