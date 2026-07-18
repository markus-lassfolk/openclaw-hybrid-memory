/**
 * Attention steward — ranks what deserves attention across Loom objects and what
 * should be demoted, snoozed, or forgotten (Issue #2153).
 */
import type { LoomStore } from "../backends/loom-store.js";
import { type SerendipityStore, scoreFinding } from "../backends/serendipity-store.js";
import type {
  AttentionCategory,
  AttentionItem,
  AttentionRankOptions,
  AttentionRankReport,
} from "../types/attention-types.js";

export interface AttentionStewardDeps {
  loomStore: LoomStore;
  serendipityStore?: SerendipityStore | null;
}

function categoryForClaim(status: string, liveCheckUnsatisfied: boolean): AttentionCategory {
  if (liveCheckUnsatisfied) return "needs_verification";
  if (status === "contradicted") return "needs_verification";
  if (status === "stale") return "stale_or_noisy";
  if (status === "verified" || status === "believed") return "important_not_urgent";
  return "interesting_not_actionable";
}

function categoryForLoop(status: string, score: number): AttentionCategory {
  if (status === "blocked") return "blocked";
  if (score >= 0.75) return "urgent";
  if (score >= 0.5) return "important_not_urgent";
  return "interesting_not_actionable";
}

function categoryForDrift(severity: string, repairability: string): AttentionCategory {
  if (severity === "high") return "urgent";
  if (repairability === "human_review") return "needs_verification";
  return "stale_or_noisy";
}

export function rankAttention(deps: AttentionStewardDeps, opts: AttentionRankOptions = {}): AttentionRankReport {
  const { loomStore, serendipityStore } = deps;
  const targetKinds = opts.targetKinds ?? ["claim", "open_loop", "drift_finding", "serendipity_finding"];
  const overrides = new Map(loomStore.listAttentionOverrides().map((o) => [`${o.targetKind}:${o.targetId}`, o]));
  const now = new Date().toISOString();
  const items: AttentionItem[] = [];

  if (targetKinds.includes("claim")) {
    for (const claim of loomStore.listClaims({ scope: opts.scope, entity: opts.entity, limit: 500 })) {
      if (claim.status === "superseded") continue;
      const liveStatus = loomStore.getLiveCheckStatus(claim.id);
      const unsatisfied = liveStatus.state === "required_unsatisfied" || liveStatus.state === "expired";
      const base = unsatisfied
        ? 0.9
        : claim.status === "contradicted"
          ? 0.85
          : claim.status === "stale"
            ? 0.3
            : claim.confidence;
      items.push({
        targetKind: "claim",
        targetId: claim.id,
        title: `${claim.entity} ${claim.predicate} = ${claim.value}`,
        category: categoryForClaim(claim.status, unsatisfied),
        score: base,
        reasons: unsatisfied ? [`live check ${liveStatus.state}`] : [`status: ${claim.status}`],
        scope: claim.scope,
        overridden: null,
      });
    }
  }

  if (targetKinds.includes("open_loop")) {
    for (const loop of loomStore.listOpenLoops({ scope: opts.scope, entity: opts.entity, limit: 500 })) {
      if (loop.status === "closed" || loop.status === "superseded") continue;
      const score = loop.urgency * 0.5 + loop.importance * 0.3 + loop.operatorLoadRisk * 0.2;
      items.push({
        targetKind: "open_loop",
        targetId: loop.id,
        title: loop.title,
        category: categoryForLoop(loop.status, score),
        score,
        reasons: [`status: ${loop.status}`, `urgency ${loop.urgency}`, `importance ${loop.importance}`],
        scope: loop.scope,
        overridden: null,
      });
    }
  }

  if (targetKinds.includes("drift_finding")) {
    for (const finding of loomStore.listDriftFindings({ status: ["open", "acknowledged"], limit: 500 })) {
      const score = finding.severity === "high" ? 0.85 : finding.severity === "medium" ? 0.5 : 0.2;
      items.push({
        targetKind: "drift_finding",
        targetId: finding.id,
        title: finding.oldText.slice(0, 100),
        category: categoryForDrift(finding.severity, finding.repairability),
        score,
        reasons: [`severity: ${finding.severity}`, `repairability: ${finding.repairability}`],
        scope: null,
        overridden: null,
      });
    }
  }

  if (targetKinds.includes("serendipity_finding") && serendipityStore) {
    for (const finding of serendipityStore.list({ limit: 200 })) {
      // Loom alignment (#2149): only still-noticing items belong in the ranked queue — once
      // promoted (fixed/filed/proposed), the item is real tracked work elsewhere, not attention-inbox noise.
      if (!finding.notAnActiveTask) continue;
      if (opts.scope && finding.repo !== opts.scope && finding.entity !== opts.scope) continue;
      const score = Math.min(1, scoreFinding(finding) / 5);
      const category: AttentionCategory =
        finding.suggestedAction === "propose_skill"
          ? "candidate_for_skill_or_wrapper"
          : finding.riskLevel === "high"
            ? "urgent"
            : "interesting_not_actionable";
      items.push({
        targetKind: "serendipity_finding",
        targetId: finding.id,
        title: finding.title,
        category,
        score,
        reasons: [`risk: ${finding.riskLevel}`, `suggested: ${finding.suggestedAction}`],
        scope: finding.repo ?? finding.entity ?? null,
        overridden: null,
      });
    }
  }

  const withOverrides = items.map((item) => {
    const ov = overrides.get(`${item.targetKind}:${item.targetId}`);
    if (!ov) return item;
    if (ov.action === "snooze" && (!ov.snoozedUntil || ov.snoozedUntil > now)) {
      return { ...item, overridden: "snooze" as const, score: -1 };
    }
    if (ov.action === "demote") {
      return { ...item, overridden: "demote" as const, score: item.score * 0.2, category: "stale_or_noisy" as const };
    }
    return item;
  });

  const visible = opts.includeSnoozed ? withOverrides : withOverrides.filter((i) => i.overridden !== "snooze");
  visible.sort((a, b) => b.score - a.score);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 20;

  return { generatedAt: now, items: visible.slice(0, limit), totalConsidered: items.length };
}
