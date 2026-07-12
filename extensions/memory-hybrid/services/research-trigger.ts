/**
 * Research trigger policy (proactive research loop, step A2 — docs/PROACTIVE-RESEARCH.md).
 *
 * Deterministic, no-LLM gate deciding which synthesized insight (if any) graduates to overnight
 * research: importance threshold, evidence-count gate, topic/text blocklist, per-slug cooldown,
 * and a hard per-night budget. The pick is recorded as an `ops_status` queue fact whose entity
 * (`research:<slug>`) doubles as the cooldown marker — no new table. The queue fact's provenance
 * points at the insight, whose provenance points at the raw evidence: the "why did my agent
 * decide to research this?" question is always answerable by walking that chain.
 */
import type { DatabaseSync } from "node:sqlite";

export interface ResearchTriggerFactsDb {
  store(entry: {
    text: string;
    category: string;
    importance: number;
    entity: string | null;
    key: string | null;
    value: string | null;
    source: string;
    tags: string[];
    provenanceJson?: string | null;
  }): { id: string };
  getRawDb(): DatabaseSync;
}

export interface ResearchTriggerPolicy {
  minImportance: number;
  minEvidence: number;
  cooldownDays: number;
  maxPerNight: number;
  topicBlocklist: string[];
}

export interface ResearchTriggerResult {
  eligible: number;
  picked: number;
  skippedCooldown: number;
  skippedBlocklist: number;
  skippedEvidence: number;
}

/** Sensitive material must never leave the machine via a research prompt, whatever the topic label says. */
const SENSITIVE_TEXT_RE = /credential|password|token|secret|api[-_ ]?key/i;

function insightSlug(entity: string | null): string | null {
  if (!entity?.startsWith("insight:")) return null;
  const slug = entity.slice("insight:".length).trim();
  return slug.length > 0 ? slug : null;
}

function countEvidence(provenanceJson: string | null): number {
  if (!provenanceJson) return 0;
  try {
    const parsed = JSON.parse(provenanceJson) as {
      sourceFactIds?: unknown;
      sourceEventIds?: unknown;
      sourceGoalEvidence?: unknown;
      sourceIdentityEvidence?: unknown;
    };
    const facts = Array.isArray(parsed.sourceFactIds) ? parsed.sourceFactIds.length : 0;
    const events = Array.isArray(parsed.sourceEventIds) ? parsed.sourceEventIds.length : 0;
    const goals = Array.isArray(parsed.sourceGoalEvidence) ? parsed.sourceGoalEvidence.length : 0;
    const identity = Array.isArray(parsed.sourceIdentityEvidence) ? parsed.sourceIdentityEvidence.length : 0;
    return facts + events + goals + identity;
  } catch {
    return 0;
  }
}

export function runResearchTrigger(
  factsDb: ResearchTriggerFactsDb,
  cfg: ResearchTriggerPolicy,
  opts?: { nowSec?: number },
): ResearchTriggerResult {
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const db = factsDb.getRawDb();
  const result: ResearchTriggerResult = {
    eligible: 0,
    picked: 0,
    skippedCooldown: 0,
    skippedBlocklist: 0,
    skippedEvidence: 0,
  };

  const candidates = db
    .prepare(
      `SELECT id, text, entity, value, importance, provenance_json FROM facts
        WHERE category = 'insight' AND superseded_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
          AND created_at >= ? AND importance >= ?
        ORDER BY importance DESC, created_at DESC LIMIT 20`,
    )
    .all(nowSec, nowSec - 7 * 86_400, cfg.minImportance) as Array<{
    id: string;
    text: string;
    entity: string | null;
    value: string | null;
    importance: number;
    provenance_json: string | null;
  }>;

  const cooldownStart = nowSec - cfg.cooldownDays * 86_400;
  const cooldownStmt = db.prepare(
    "SELECT 1 FROM facts WHERE entity = ? AND created_at >= ? LIMIT 1", // queue facts count even when superseded/done
  );
  const blocklist = cfg.topicBlocklist.map((t) => t.toLowerCase());

  for (const c of candidates) {
    const slug = insightSlug(c.entity);
    if (!slug) continue;
    if (blocklist.includes((c.value ?? "").toLowerCase()) || SENSITIVE_TEXT_RE.test(c.text)) {
      result.skippedBlocklist++;
      continue;
    }
    if (countEvidence(c.provenance_json) < cfg.minEvidence) {
      result.skippedEvidence++;
      continue;
    }
    if (cooldownStmt.get(`research:${slug}`, cooldownStart)) {
      result.skippedCooldown++;
      continue;
    }
    result.eligible++;
    if (result.picked >= cfg.maxPerNight) continue; // keep counting eligibility for the summary
    factsDb.store({
      text: `Research queued: ${c.text.replace(/\s+/g, " ").slice(0, 200)}`,
      category: "ops_status",
      importance: 0.4,
      entity: `research:${slug}`,
      key: "status",
      value: "picked",
      source: "research-trigger",
      tags: ["research-queue"],
      provenanceJson: JSON.stringify({ method: "research-trigger", sourceFactIds: [c.id] }),
    });
    result.picked++;
  }

  return result;
}
