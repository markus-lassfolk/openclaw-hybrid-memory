/**
 * Proactive research loop A2: the deterministic trigger policy. Importance floor, evidence gate,
 * blocklist (topic label + sensitive-text regex), per-slug cooldown via the queue-fact entity
 * marker, and the per-night budget — every skip is counted, every pick leaves an audit chain.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { runResearchTrigger } from "../services/research-trigger.js";

let dir: string;
let db: FactsDB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hybrid-trigger-"));
  db = new FactsDB(join(dir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const policy = {
  minImportance: 0.74,
  minEvidence: 2,
  cooldownDays: 14,
  maxPerNight: 1,
  topicBlocklist: ["credential", "secret", "security"],
};

function storeInsight(
  slug: string,
  importance: number,
  opts?: { topic?: string; text?: string; evidence?: number; createdAt?: number },
): string {
  const evidenceCount = opts?.evidence ?? 2;
  const id = db.store({
    text: opts?.text ?? `Insight: user shows recurring pattern ${slug}`,
    entity: `insight:${slug}`,
    key: "concern",
    value: opts?.topic ?? "productivity",
    category: "insight",
    importance,
    source: "insight-synthesis",
    tags: ["insight", "auto"],
    provenanceJson: JSON.stringify({
      method: "insight-synthesis",
      sourceFactIds: Array.from({ length: evidenceCount }, (_, i) => `f${i}`),
      sourceEventIds: [],
    }),
  } as never).id;
  if (opts?.createdAt !== undefined) {
    db.getRawDb().prepare("UPDATE facts SET created_at = ? WHERE id = ?").run(opts.createdAt, id);
  }
  return id;
}

function queueFacts(): Array<{ entity: string; value: string; provenance_json: string }> {
  return db
    .getRawDb()
    .prepare("SELECT entity, value, provenance_json FROM facts WHERE category = 'ops_status' ORDER BY created_at")
    .all() as never;
}

describe("research trigger policy", () => {
  it("picks the single highest-importance eligible insight and writes the audit queue fact", () => {
    storeInsight("lesser-concern", 0.8);
    const topId = storeInsight("sleep-procrastination", 0.9);

    const r = runResearchTrigger(db, policy);

    expect(r.picked).toBe(1);
    expect(r.eligible).toBe(2);
    const queue = queueFacts();
    expect(queue).toHaveLength(1);
    expect(queue[0].entity).toBe("research:sleep-procrastination");
    expect(queue[0].value).toBe("picked");
    expect(JSON.parse(queue[0].provenance_json).sourceFactIds).toEqual([topId]);
  });

  it("cooldown blocks re-pick for the same slug, then releases after expiry", () => {
    storeInsight("sleep-procrastination", 0.9);
    const now = Math.floor(Date.now() / 1000);

    expect(runResearchTrigger(db, policy, { nowSec: now }).picked).toBe(1);
    const again = runResearchTrigger(db, policy, { nowSec: now });
    expect(again.picked).toBe(0);
    expect(again.skippedCooldown).toBe(1);

    // Age the queue marker past the cooldown; keep the insight inside the 7d candidate window.
    db.getRawDb()
      .prepare("UPDATE facts SET created_at = ? WHERE entity = 'research:sleep-procrastination'")
      .run(now - (policy.cooldownDays + 1) * 86_400);
    expect(runResearchTrigger(db, policy, { nowSec: now }).picked).toBe(1);
  });

  it("blocklists by topic label and by sensitive text regardless of label", () => {
    storeInsight("blocked-topic", 0.9, { topic: "security" });
    storeInsight("leaky-text", 0.9, { text: "Insight: user keeps pasting an API key into chats" });

    const r = runResearchTrigger(db, policy);

    expect(r.picked).toBe(0);
    expect(r.skippedBlocklist).toBe(2);
  });

  it("skips insights below the evidence gate, and below the importance floor entirely", () => {
    storeInsight("thin-evidence", 0.9, { evidence: 1 });
    storeInsight("low-salience", 0.6);

    const r = runResearchTrigger(db, policy);

    expect(r.picked).toBe(0);
    expect(r.skippedEvidence).toBe(1);
    expect(r.eligible).toBe(0); // low-salience never reaches the candidate set
  });

  it("maxPerNight caps picks while eligibility is still counted; stale insights are not candidates", () => {
    const now = Math.floor(Date.now() / 1000);
    storeInsight("concern-a", 0.9);
    storeInsight("concern-b", 0.85);
    storeInsight("stale-concern", 0.95, { createdAt: now - 10 * 86_400 });

    const r = runResearchTrigger(db, policy, { nowSec: now });

    expect(r.picked).toBe(1);
    expect(r.eligible).toBe(2);
    expect(queueFacts()[0].entity).toBe("research:concern-a");
  });

  it("counts goal/identity evidence toward the evidence gate — a goal-only insight is still eligible", () => {
    db.store({
      text: "Insight: user's active goals show a stagnation pattern",
      entity: "insight:goal-stagnation",
      key: "concern",
      value: "growth",
      category: "insight",
      importance: 0.9,
      source: "insight-synthesis",
      tags: ["insight", "auto"],
      provenanceJson: JSON.stringify({
        method: "insight-synthesis",
        sourceFactIds: [],
        sourceEventIds: [],
        sourceGoalEvidence: [
          { id: "goal-1", text: 'Goal "ship v2" (priority: high, status: active, active 40d, ...)' },
        ],
        sourceIdentityEvidence: [{ id: "id-1", text: "[partnership] ... durable" }],
      }),
    } as never);

    const r = runResearchTrigger(db, policy);

    expect(r.picked).toBe(1);
    expect(r.skippedEvidence).toBe(0);
    expect(queueFacts()[0].entity).toBe("research:goal-stagnation");
  });
});
