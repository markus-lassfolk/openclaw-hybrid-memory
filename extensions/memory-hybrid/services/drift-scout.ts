/**
 * Drift scout — detects stale instructions, deprecated commands, and contradictions
 * across facts (Issue #2146). Report-only by default; `--apply-safe` only performs
 * mechanical, already-identified string replacements on affected fact text.
 */
import type { DatabaseSync } from "node:sqlite";
import { getContradictions } from "../backends/facts-db/contradictions.js";
import type { FactsDB } from "../backends/facts-db.js";
import { driftDedupHash } from "../backends/loom/drift.js";
import type { LoomStore } from "../backends/loom-store.js";
import type {
  CreateDriftFindingInput,
  DriftAffectedRef,
  DriftFinding,
  DriftScoutOptions,
  DriftScoutReport,
} from "../types/drift-types.js";

/** Deprecated-command references found in fact text (cron payloads, wiki, skills would scan the same way if wired in). */
export function scanFactsForDeprecatedCommands(
  facts: Array<{ id: string; text: string; category?: string }>,
  deprecatedCommands: Record<string, string>,
): CreateDriftFindingInput[] {
  const findings: CreateDriftFindingInput[] = [];
  const entries = Object.entries(deprecatedCommands);
  if (entries.length === 0) return findings;
  for (const [oldCmd, newCmd] of entries) {
    const affected: DriftAffectedRef[] = [];
    for (const fact of facts) {
      if (fact.text.includes(oldCmd)) {
        affected.push({ kind: "fact", id: fact.id, label: fact.category });
      }
    }
    if (affected.length === 0) continue;
    findings.push({
      driftType: "deprecated_command",
      oldText: oldCmd,
      replacementText: newCmd,
      affectedIds: affected,
      severity: "medium",
      repairability: "auto_safe",
      suggestedRepair: `Replace "${oldCmd}" with "${newCmd}" in ${affected.length} affected fact(s).`,
    });
  }
  return findings;
}

/** Unresolved contradictions surfaced as drift so they enter the same review queue as everything else. */
export function scanFactsForContradictions(db: DatabaseSync, limit = 100): CreateDriftFindingInput[] {
  const contradictions = getContradictions(db, undefined, limit).filter((c) => !c.resolved);
  return contradictions.map((c) => ({
    driftType: "contradicted_fact",
    oldText: `Fact ${c.factIdOld} is contradicted by newer fact ${c.factIdNew}`,
    affectedIds: [
      { kind: "fact", id: c.factIdOld },
      { kind: "fact", id: c.factIdNew },
    ],
    severity: "medium",
    repairability: "human_review",
    suggestedRepair: `Resolve contradiction ${c.id} (openclaw hybrid-mem contradictions resolve ${c.id}).`,
  }));
}

export interface DriftScoutDeps {
  factsDb: FactsDB;
  loomStore: LoomStore;
}

export function runDriftScout(
  deps: DriftScoutDeps,
  opts: DriftScoutOptions & { deprecatedCommands: Record<string, string> },
): DriftScoutReport {
  const { factsDb, loomStore } = deps;
  const include = opts.include ?? ["facts", "cron", "skills", "wiki"];
  const db = factsDb.getRawDb();

  const candidates: CreateDriftFindingInput[] = [];
  if (include.includes("facts")) {
    const facts = factsDb
      .getAll({ includeSuperseded: false })
      .map((f) => ({ id: f.id, text: f.text, category: f.category }));
    candidates.push(...scanFactsForDeprecatedCommands(facts, opts.deprecatedCommands));
    candidates.push(...scanFactsForContradictions(db));
  }

  let newCount = 0;
  let existingCount = 0;
  const findings: DriftFinding[] = [];
  for (const candidate of candidates) {
    const hash = driftDedupHash({ driftType: candidate.driftType, oldText: candidate.oldText });
    const existing = loomStore.findDriftByDedupHash(hash);
    if (existing) {
      existingCount++;
      findings.push(existing);
      continue;
    }
    const created = loomStore.createDriftFinding(candidate);
    newCount++;
    findings.push(created);
  }

  let appliedSafeCount = 0;
  if (opts.applySafe) {
    for (let i = 0; i < findings.length; i++) {
      const finding = findings[i] as DriftFinding;
      if (finding.repairability !== "auto_safe" || finding.status !== "open") continue;
      if (finding.driftType === "deprecated_command" && finding.replacementText) {
        appliedSafeCount += applySafeDeprecatedCommandFix(db, finding);
        findings[i] = loomStore.updateDriftStatus(finding.id, "resolved");
      }
    }
  }

  return { scannedAt: new Date().toISOString(), findings, newCount, existingCount, appliedSafeCount };
}

/** Mechanical string replacement of a deprecated command in the text of every affected fact. Returns rows changed. */
function applySafeDeprecatedCommandFix(db: DatabaseSync, finding: DriftFinding): number {
  if (!finding.replacementText) return 0;
  let changed = 0;
  const select = db.prepare("SELECT id, text FROM facts WHERE id = ?");
  const update = db.prepare("UPDATE facts SET text = ? WHERE id = ?");
  for (const ref of finding.affectedIds) {
    if (ref.kind !== "fact") continue;
    const row = select.get(ref.id) as { id: string; text: string } | undefined;
    if (!row?.text.includes(finding.oldText)) continue;
    const nextText = row.text.split(finding.oldText).join(finding.replacementText);
    update.run(nextText, row.id);
    changed++;
  }
  return changed;
}
