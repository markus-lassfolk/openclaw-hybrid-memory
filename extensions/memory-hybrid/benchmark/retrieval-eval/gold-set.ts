/**
 * Deterministic retrieval-quality fixture: ~200 synthetic facts + 30 gold queries with known
 * relevant sets. Zero LLM/embedding dependencies (queries anchor on rare tokens so the FTS5
 * strategy is fully deterministic) — this is the CI regression floor for ranking changes; the
 * real-embedding gold set grows on top of it in benchmark/retrieval-eval (P5).
 *
 * Shape: 10 topics × 3 "anchor" facts sharing one rare topic token (the relevant set for that
 * topic's queries) + 170 distractor facts sharing common vocabulary but never the anchor tokens.
 */

export interface FixtureFact {
  /** Stable fixture key (gold queries reference these, ids are assigned at seed time). */
  fixtureKey: string;
  text: string;
  category: string;
  entity: string | null;
  importance: number;
}

export interface GoldQuery {
  query: string;
  /** fixtureKeys of ALL facts relevant to this query. */
  relevant: string[];
}

const TOPICS = [
  { token: "zylophant", theme: "the zylophant reactor cooling loop" },
  { token: "quorvax", theme: "the quorvax billing reconciliation job" },
  { token: "brimwold", theme: "the brimwold customer onboarding flow" },
  { token: "skellrun", theme: "the skellrun CI pipeline cache" },
  { token: "fenwick9", theme: "the fenwick9 gateway rate limiter" },
  { token: "moxutide", theme: "the moxutide database migration tooling" },
  { token: "parvolex", theme: "the parvolex mobile push notifications" },
  { token: "grendulax", theme: "the grendulax analytics warehouse" },
  { token: "thrimbal", theme: "the thrimbal auth token rotation" },
  { token: "vexmoor", theme: "the vexmoor edge deployment region" },
] as const;

const ANCHOR_TEMPLATES = [
  (theme: string, token: string) => `Decision: ${theme} must fail closed when the ${token} health probe times out`,
  (theme: string, token: string) => `The ${token} runbook says ${theme} is restarted only after draining its queue`,
  (theme: string, token: string) => `Markus prefers ${theme} alerts routed to the ${token} channel before paging`,
] as const;

const DISTRACTOR_SUBJECTS = [
  "the staging environment",
  "the weekly report",
  "the release checklist",
  "the customer demo",
  "the retro notes",
  "the budget review",
  "the sprint board",
  "the design doc",
  "the support rota",
  "the vendor contract",
] as const;

const DISTRACTOR_VERBS = [
  "was updated to require sign-off from two reviewers",
  "moves to Tuesday afternoons starting next month",
  "needs the health probe timeout raised to thirty seconds",
  "should route alerts to the on-call channel before paging",
  "must fail closed when the upstream dependency is degraded",
  "is restarted only after draining outstanding work",
  "keeps its cache warm across deployments now",
  "gets reconciled against the billing export nightly",
  "was migrated to the new warehouse cluster",
  "rotates its credentials every ninety days",
] as const;

export function buildFixtureFacts(): FixtureFact[] {
  const facts: FixtureFact[] = [];
  for (const topic of TOPICS) {
    ANCHOR_TEMPLATES.forEach((template, i) => {
      facts.push({
        fixtureKey: `${topic.token}-anchor-${i}`,
        text: template(topic.theme, topic.token),
        category: i === 2 ? "preference" : "decision",
        entity: topic.token,
        importance: 0.8,
      });
    });
  }
  // Distractors deliberately reuse the anchors' generic vocabulary (probe, alerts, restarted,
  // fail closed, draining...) so BM25 must rank on the rare topic tokens, not sentence shape.
  let d = 0;
  for (const subject of DISTRACTOR_SUBJECTS) {
    for (const verb of DISTRACTOR_VERBS) {
      facts.push({
        fixtureKey: `distractor-${d}`,
        text: `Note ${d}: ${subject} ${verb}`,
        category: "fact",
        entity: null,
        importance: 0.5,
      });
      d++;
    }
  }
  // 30 anchors + 100 distractors × repeated verb variants to reach ~200.
  for (let extra = 0; extra < 70; extra++) {
    const subject = DISTRACTOR_SUBJECTS[extra % DISTRACTOR_SUBJECTS.length];
    const verb = DISTRACTOR_VERBS[(extra * 3 + 1) % DISTRACTOR_VERBS.length];
    facts.push({
      fixtureKey: `distractor-${d + extra}`,
      text: `Follow-up ${extra}: ${subject} also ${verb}`,
      category: "fact",
      entity: null,
      importance: 0.4,
    });
  }
  return facts;
}

export function buildGoldQueries(): GoldQuery[] {
  const queries: GoldQuery[] = [];
  for (const topic of TOPICS) {
    const relevant = [0, 1, 2].map((i) => `${topic.token}-anchor-${i}`);
    // Three phrasings per topic: token-forward, operational, preference-flavored.
    queries.push(
      { query: `${topic.token} health probe`, relevant },
      { query: `how do we restart ${topic.token}`, relevant },
      { query: `${topic.token} alert routing`, relevant },
    );
  }
  return queries; // 10 topics × 3 = 30
}
