/**
 * Loom brief — pre-action synthesis (Issue #2154). Composes beliefs, open loops,
 * evidence, drift, and attention into one bounded, prompt-safe briefing that
 * explicitly separates memory from proof.
 */
import type { LoomStore } from "../backends/loom-store.js";
import type {
  LoomBrief,
  LoomBriefBeliefItem,
  LoomBriefDriftWarning,
  LoomBriefEvidence,
  LoomBriefLiveCheck,
  LoomBriefOpenLoop,
  LoomBriefOptions,
} from "../types/loom-brief-types.js";
import { rankAttention } from "./attention-steward.js";

export interface LoomBriefDeps {
  loomStore: LoomStore;
}

function tokenize(scope: string): string[] {
  return scope
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function matchesScope(haystack: string[], tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const text = haystack.filter(Boolean).join(" ").toLowerCase();
  return tokens.some((t) => text.includes(t));
}

export function buildLoomBrief(deps: LoomBriefDeps, opts: LoomBriefOptions): LoomBrief {
  const { loomStore } = deps;
  const maxChars = opts.maxChars ?? 4000;
  const scope = opts.scope ?? "";
  const tokens = tokenize(scope);
  const broad = tokens.length === 0;

  const allClaims = loomStore.listClaims({ limit: 500 });
  const matchedClaims = allClaims.filter((c) => matchesScope([c.entity, c.predicate, c.value, c.scope ?? ""], tokens));

  const verifiedBeliefs: LoomBriefBeliefItem[] = [];
  const staleOrUnverifiedBeliefs: LoomBriefBeliefItem[] = [];
  const contradictions: LoomBriefBeliefItem[] = [];
  const mustLiveCheck: LoomBriefLiveCheck[] = [];

  for (const claim of matchedClaims) {
    const item: LoomBriefBeliefItem = {
      label: "memory",
      claimId: claim.id,
      text: `${claim.entity} ${claim.predicate} = ${claim.value}`,
      status: claim.status,
      confidence: claim.confidence,
    };
    if (claim.status === "contradicted") {
      contradictions.push(item);
    } else if (claim.status === "verified") {
      verifiedBeliefs.push({ ...item, label: "evidence" });
    } else if (claim.status === "stale" || claim.status === "unverified" || claim.status === "believed") {
      staleOrUnverifiedBeliefs.push(item);
    }
    const liveStatus = loomStore.getLiveCheckStatus(claim.id);
    if (liveStatus.state === "required_unsatisfied" || liveStatus.state === "expired") {
      mustLiveCheck.push({
        label: "live_check_requirement",
        claimId: claim.id,
        text: `${claim.entity} ${claim.predicate} requires a live check${liveStatus.reason ? ` — ${liveStatus.reason}` : ""} (${liveStatus.state})`,
        suggestedChecks: liveStatus.suggestedChecks.map((c) => c.text),
      });
    }
  }

  const matchedLoops = loomStore
    .listOpenLoops({ limit: 500 })
    .filter((l) => l.status !== "closed" && l.status !== "superseded")
    .filter((l) => matchesScope([l.title, l.description, l.scope ?? "", l.entity ?? "", l.repo ?? ""], tokens));
  const openLoops: LoomBriefOpenLoop[] = matchedLoops
    .sort((a, b) => b.urgency + b.importance - (a.urgency + a.importance))
    .map((l) => ({
      label: "memory" as const,
      loopId: l.id,
      title: l.title,
      status: l.status,
      closureCriteria: l.closureCriteria,
    }));

  const matchedCapsuleIds = new Set(matchedClaims.flatMap((c) => c.evidenceCapsuleIds));
  const recentEvidence: LoomBriefEvidence[] = Array.from(matchedCapsuleIds)
    .map((id) => loomStore.getEvidenceCapsule(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10)
    .map((c) => ({ label: "evidence" as const, capsuleId: c.id, title: c.title, createdAt: c.createdAt }));

  const driftFindings = loomStore
    .listDriftFindings({ status: ["open", "acknowledged"], limit: 200 })
    .filter((f) => broad || matchesScope([f.oldText, f.replacementText ?? ""], tokens));
  const driftWarnings: LoomBriefDriftWarning[] = driftFindings.slice(0, 10).map((f) => ({
    label: "recommendation" as const,
    driftId: f.id,
    text: f.oldText.slice(0, 120),
    severity: f.severity,
  }));

  const attention = rankAttention({ loomStore }, { scope: broad ? undefined : scope, limit: 5 });
  const attentionPriorities = attention.items.map((i) => `[${i.category}] ${i.title}`);

  const nextActions: string[] = [];
  if (mustLiveCheck.length > 0) {
    nextActions.push(
      `Verify live state before acting: ${mustLiveCheck.map((m) => m.suggestedChecks.join(", ") || m.text).join("; ")}`,
    );
  }
  if (contradictions.length > 0) {
    nextActions.push(`Resolve ${contradictions.length} contradicted belief(s) before treating them as truth.`);
  }
  if (openLoops.length > 0) {
    nextActions.push(`${openLoops.length} open loop(s) pending — see next action per loop.`);
  }
  if (driftWarnings.length > 0) {
    nextActions.push(`${driftWarnings.length} drift warning(s) — memory may reference stale/deprecated state.`);
  }
  if (nextActions.length === 0) {
    nextActions.push(
      "No blocking issues found for this scope. Memory is context, not proof — verify live state before mutating anything.",
    );
  }

  const brief: LoomBrief = {
    scope,
    generatedAt: new Date().toISOString(),
    scopeInterpretation: broad ? "workspace-wide (no scope filter)" : `scoped to "${scope}"`,
    verifiedBeliefs,
    staleOrUnverifiedBeliefs,
    contradictions,
    mustLiveCheck,
    openLoops,
    recentEvidence,
    driftWarnings,
    recommendedProcedures: [],
    attentionPriorities,
    nextActions,
    truncated: false,
  };

  return boundBrief(brief, maxChars);
}

export function renderLoomBriefMarkdown(brief: LoomBrief): string {
  const lines: string[] = [`## Loom brief: ${brief.scopeInterpretation}`];
  if (brief.mustLiveCheck.length > 0) {
    lines.push("", "### Must live-check before acting");
    for (const c of brief.mustLiveCheck) lines.push(`- ${c.text}`);
  }
  if (brief.contradictions.length > 0) {
    lines.push("", "### Contradictions");
    for (const c of brief.contradictions) lines.push(`- ${c.text}`);
  }
  if (brief.verifiedBeliefs.length > 0) {
    lines.push("", "### Verified beliefs");
    for (const b of brief.verifiedBeliefs) lines.push(`- ${b.text} (confidence ${b.confidence})`);
  }
  if (brief.staleOrUnverifiedBeliefs.length > 0) {
    lines.push("", "### Stale / unverified beliefs");
    for (const b of brief.staleOrUnverifiedBeliefs) lines.push(`- ${b.text} (${b.status})`);
  }
  if (brief.openLoops.length > 0) {
    lines.push("", "### Open loops");
    for (const l of brief.openLoops)
      lines.push(`- [${l.status}] ${l.title}${l.closureCriteria ? ` — closes when: ${l.closureCriteria}` : ""}`);
  }
  if (brief.recentEvidence.length > 0) {
    lines.push("", "### Recent evidence");
    for (const e of brief.recentEvidence) lines.push(`- ${e.title} (${e.createdAt})`);
  }
  if (brief.driftWarnings.length > 0) {
    lines.push("", "### Drift warnings");
    for (const d of brief.driftWarnings) lines.push(`- [${d.severity}] ${d.text}`);
  }
  if (brief.attentionPriorities.length > 0) {
    lines.push("", "### Attention priorities");
    for (const a of brief.attentionPriorities) lines.push(`- ${a}`);
  }
  lines.push("", "### Next actions");
  for (const a of brief.nextActions) lines.push(`- ${a}`);
  if (brief.truncated) lines.push("", "_(brief truncated to fit the character budget)_");
  return lines.join("\n");
}

function estimateChars(brief: LoomBrief): number {
  return JSON.stringify(brief).length;
}

/** Trim the largest sections first until the brief fits maxChars, marking `truncated`. */
function boundBrief(brief: LoomBrief, maxChars: number): LoomBrief {
  let current = { ...brief };
  const trimmable: Array<keyof LoomBrief> = [
    "staleOrUnverifiedBeliefs",
    "recentEvidence",
    "driftWarnings",
    "verifiedBeliefs",
    "openLoops",
    "contradictions",
    "mustLiveCheck",
  ];
  let truncated = false;
  let guard = 0;
  while (estimateChars(current) > maxChars && guard < 50) {
    guard++;
    let trimmedSomething = false;
    for (const key of trimmable) {
      const arr = current[key];
      if (Array.isArray(arr) && arr.length > 0) {
        current = { ...current, [key]: arr.slice(0, -1) };
        trimmedSomething = true;
        truncated = true;
        if (estimateChars(current) <= maxChars) break;
      }
    }
    if (!trimmedSomething) break;
  }
  return { ...current, truncated };
}
