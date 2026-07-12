/**
 * Proactive research loop A1: insight synthesis. The LLM only ever cites numbered evidence refs
 * (F#/S#/G#/I#) that the service maps back to real fact/signal/goal/identity-reflection ids —
 * hallucinated evidence is dropped wholesale, insights dedupe by slug entity, and caps/windows are
 * enforced deterministically.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdentityReflectionStore } from "../backends/identity-reflection-store.js";
import { FactsDB } from "../backends/facts-db.js";
import { parseResearchConfig } from "../config/parsers/research.js";
import { writeGoal } from "../services/goal-registry.js";
import { runInsightSynthesis, slugifyInsight } from "../services/insight-synthesis.js";
import { baseGoal } from "./helpers/goal-helpers.js";

let dir: string;
let db: FactsDB;
const logger = { info: () => {}, warn: () => {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hybrid-insight-"));
  db = new FactsDB(join(dir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function mockOpenai(content: string, onCall?: () => void) {
  return {
    chat: {
      completions: {
        create: async () => {
          onCall?.();
          return { choices: [{ message: { content } }] };
        },
      },
    },
  } as never;
}

function storeFact(text: string, category: string, extra?: { valence?: number; createdAt?: number }): string {
  const id = db.store({
    text,
    entity: null,
    key: null,
    value: null,
    category,
    importance: 0.5,
    source: "test",
    tags: [],
  } as never).id;
  if (extra?.valence !== undefined) {
    db.getRawDb().prepare("UPDATE facts SET valence = ? WHERE id = ?").run(extra.valence, id);
  }
  if (extra?.createdAt !== undefined) {
    db.getRawDb().prepare("UPDATE facts SET created_at = ? WHERE id = ?").run(extra.createdAt, id);
  }
  return id;
}

function storeSignal(session: string, message: string, atSec: number): number {
  db.getRawDb()
    .prepare(
      `INSERT INTO implicit_signals (session_file, signal_type, confidence, polarity, user_message, source, created_at)
       VALUES (?, 'explicit_frustration', 0.8, 'negative', ?, 'frustration', ?)`,
    )
    .run(session, message, atSec);
  const row = db.getRawDb().prepare("SELECT MAX(id) AS id FROM implicit_signals").get() as { id: number };
  return row.id;
}

/** 1 negative-valence fact + 2 routines + 2 signals = 5 evidence items; F1 = the valence fact. */
function seedBaseline(now: number): { negId: string; signalIds: number[] } {
  const negId = storeFact("Working past midnight again, exhausted", "fact", { valence: -0.7 });
  storeFact("Routine: on Tuesday nights, a recurring focus is late work", "routine");
  storeFact("Routine: on Friday mornings, a recurring focus is planning", "routine");
  const s1 = storeSignal("sess-a", "why is this STILL broken at 1am", now - 3600);
  const s2 = storeSignal("sess-b", "so tired of redoing this", now - 7200);
  return { negId, signalIds: [s1, s2] };
}

const cfg = { maxPerRun: 2, windowDays: 7, minEvidence: 2, model: "test-model", fallbackModels: [] };

function insightJson(insights: unknown[]): string {
  return JSON.stringify({ insights });
}

const VALID_INSIGHT = {
  insight: "User repeatedly works past midnight and shows fatigue afterwards",
  whyItMatters: "Sleep procrastination may be hurting focus",
  salience: 0.8,
  topic: "wellbeing",
  evidence: ["F1", "S1"],
};

describe("insight synthesis", () => {
  it("stores an evidence-linked insight fact, mapping refs back to real ids", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { negId, signalIds } = seedBaseline(now);

    const r = await runInsightSynthesis(db, mockOpenai(insightJson([VALID_INSIGHT])), cfg, { dryRun: false }, logger);

    expect(r.semanticOutcome).toBe("success");
    expect(r.evidenceItems).toBe(5);
    expect(r.stored).toBe(1);
    const row = db
      .getRawDb()
      .prepare("SELECT text, entity, value, importance, tags, provenance_json FROM facts WHERE category = 'insight'")
      .get() as {
      text: string;
      entity: string;
      value: string;
      importance: number;
      tags: string;
      provenance_json: string;
    };
    expect(row.text).toContain("User repeatedly works past midnight");
    expect(row.entity).toBe(`insight:${slugifyInsight(VALID_INSIGHT.insight)}`);
    expect(row.value).toBe("wellbeing");
    expect(row.importance).toBeCloseTo(0.5 + 0.4 * 0.8, 5);
    expect(row.tags).toContain("needs-review");
    const prov = JSON.parse(row.provenance_json);
    expect(prov.method).toBe("insight-synthesis");
    expect(prov.sourceFactIds).toEqual([negId]);
    expect(prov.sourceEventIds).toEqual([`implicit_signal:${signalIds[0]}`]);
  });

  it("drops insights citing unknown refs or fewer than minEvidence", async () => {
    const now = Math.floor(Date.now() / 1000);
    seedBaseline(now);
    const hallucinated = { ...VALID_INSIGHT, evidence: ["F1", "F99"] };
    const tooFew = { ...VALID_INSIGHT, insight: "Another distinct observation about work habits", evidence: ["F1"] };

    const r = await runInsightSynthesis(
      db,
      mockOpenai(insightJson([hallucinated, tooFew])),
      cfg,
      { dryRun: false },
      logger,
    );

    expect(r.candidates).toBe(2);
    expect(r.skippedEvidence).toBe(2);
    expect(r.stored).toBe(0);
    expect(db.getRawDb().prepare("SELECT COUNT(*) AS n FROM facts WHERE category='insight'").get()).toEqual({ n: 0 });
  });

  it("caps stored insights at maxPerRun", async () => {
    seedBaseline(Math.floor(Date.now() / 1000));
    const three = ["late-night working sessions", "repeated tooling frustration", "skipped morning planning"].map(
      (theme) => ({
        ...VALID_INSIGHT,
        insight: `Recurring theme of ${theme} keeps showing up across the user's week`,
      }),
    );

    const r = await runInsightSynthesis(db, mockOpenai(insightJson(three)), cfg, { dryRun: false }, logger);

    expect(r.candidates).toBe(3);
    expect(r.stored).toBe(2);
  });

  it("dedupes by slug entity across runs", async () => {
    seedBaseline(Math.floor(Date.now() / 1000));
    const openai = mockOpenai(insightJson([VALID_INSIGHT]));

    const first = await runInsightSynthesis(db, openai, cfg, { dryRun: false }, logger);
    const second = await runInsightSynthesis(db, openai, cfg, { dryRun: false }, logger);

    expect(first.stored).toBe(1);
    expect(second.stored).toBe(0);
    expect(second.skippedDedupe).toBe(1);
  });

  it("skips quietly (no LLM call) when evidence is insufficient", async () => {
    let called = false;
    const r = await runInsightSynthesis(
      db,
      mockOpenai("{}", () => (called = true)),
      cfg,
      { dryRun: false },
      logger,
    );
    expect(called).toBe(false);
    expect(r.evidenceItems).toBe(0);
    expect(r.semanticOutcome).toBe("success");
  });

  it("dryRun counts but writes nothing", async () => {
    seedBaseline(Math.floor(Date.now() / 1000));
    const r = await runInsightSynthesis(db, mockOpenai(insightJson([VALID_INSIGHT])), cfg, { dryRun: true }, logger);
    expect(r.stored).toBe(1);
    expect(db.getRawDb().prepare("SELECT COUNT(*) AS n FROM facts WHERE category='insight'").get()).toEqual({ n: 0 });
  });

  it("returns failed with zero writes on unparseable output; empty insights array is success", async () => {
    seedBaseline(Math.floor(Date.now() / 1000));
    const bad = await runInsightSynthesis(db, mockOpenai("not json at all"), cfg, { dryRun: false }, logger);
    expect(bad.semanticOutcome).toBe("failed");
    expect(bad.stored).toBe(0);

    const empty = await runInsightSynthesis(db, mockOpenai(insightJson([])), cfg, { dryRun: false }, logger);
    expect(empty.semanticOutcome).toBe("success");
    expect(empty.candidates).toBe(0);
  });

  it("excludes evidence outside the window", async () => {
    const now = Math.floor(Date.now() / 1000);
    seedBaseline(now);
    storeFact("Old grievance far outside the window", "fact", {
      valence: -0.9,
      createdAt: now - 30 * 86_400,
    });
    storeSignal("sess-old", "ancient frustration", now - 30 * 86_400);

    const r = await runInsightSynthesis(db, mockOpenai(insightJson([])), cfg, { dryRun: false }, logger);
    expect(r.evidenceItems).toBe(5); // the two out-of-window items are not offered
  });
});

describe("insight synthesis — goal/identity evidence", () => {
  it("counts active goals toward the evidence floor and cites them as G# refs", async () => {
    const goalsDir = join(dir, "goals");
    // Distinct createdAt per goal (descending as i increases) makes the priority+recency sort in
    // loadActiveGoalsSafely fully deterministic — G1/G2 must resolve to goal-0/goal-1 regardless
    // of the filesystem's unspecified readdir() order.
    for (let i = 0; i < 5; i++) {
      await writeGoal(
        goalsDir,
        baseGoal({
          id: `goal-${i}`,
          label: `ship feature ${i}`,
          status: "active",
          priority: "high",
          createdAt: `2026-01-0${5 - i}T00:00:00.000Z`,
          currentBlockers: i === 0 ? ["waiting on design review"] : [],
        }),
      );
    }
    const goalInsight = {
      insight: "User has five active high-priority goals with little visible progress lately",
      whyItMatters: "Surfacing the backlog may help re-prioritize",
      salience: 0.7,
      topic: "growth",
      evidence: ["G1", "G2"],
    };

    const r = await runInsightSynthesis(
      db,
      mockOpenai(insightJson([goalInsight])),
      cfg,
      { dryRun: false, goalsDir },
      logger,
    );

    expect(r.evidenceItems).toBe(5);
    expect(r.stored).toBe(1);
    const row = db.getRawDb().prepare("SELECT value, provenance_json FROM facts WHERE category = 'insight'").get() as {
      value: string;
      provenance_json: string;
    };
    expect(row.value).toBe("growth");
    const prov = JSON.parse(row.provenance_json);
    expect(prov.sourceGoalEvidence).toHaveLength(2);
    expect(prov.sourceGoalEvidence[0].id).toBe("goal-0");
    expect(prov.sourceGoalEvidence[0].text).toContain("ship feature 0");
    expect(prov.sourceGoalEvidence[0].text).toContain("waiting on design review");
    expect(prov.sourceFactIds).toEqual([]);
    expect(prov.sourceEventIds).toEqual([]);
  });

  it("skips terminal goals and tolerates a missing goals dir", async () => {
    const goalsDir = join(dir, "goals");
    await writeGoal(goalsDir, baseGoal({ id: "done-goal", status: "completed" }));
    seedBaseline(Math.floor(Date.now() / 1000));

    const withGoals = await runInsightSynthesis(
      db,
      mockOpenai(insightJson([])),
      cfg,
      { dryRun: false, goalsDir },
      logger,
    );
    expect(withGoals.evidenceItems).toBe(5); // the completed goal is not active evidence

    const withMissingDir = await runInsightSynthesis(
      db,
      mockOpenai(insightJson([])),
      cfg,
      { dryRun: false, goalsDir: join(dir, "does-not-exist") },
      logger,
    );
    expect(withMissingDir.evidenceItems).toBe(5); // best-effort: a missing dir yields zero goals, not an error
  });

  it("cites only durable identity reflections, excluding temporary ones", async () => {
    const identityStore = new IdentityReflectionStore(join(dir, "identity.db"));
    try {
      identityStore.create({
        runId: "run-1",
        questionKey: "partnership",
        questionText: "What patterns define good partnership with the user?",
        insight: "The user responds well to direct, concise updates rather than long explanations",
        durability: "durable",
        confidence: 0.8,
      });
      identityStore.create({
        runId: "run-1",
        questionKey: "tradeoffs",
        questionText: "What kinds of tradeoffs do I keep making?",
        insight: "This week leaned toward speed over thoroughness on minor fixes",
        durability: "temporary",
        confidence: 0.5,
      });
      seedBaseline(Math.floor(Date.now() / 1000));

      const identityInsight = {
        insight: "The user's preference for concise updates connects to their late-night frustration",
        whyItMatters: "Terser check-ins at night may reduce friction",
        salience: 0.6,
        topic: "relationship",
        evidence: ["F1", "I1"],
      };

      const r = await runInsightSynthesis(
        db,
        mockOpenai(insightJson([identityInsight])),
        cfg,
        { dryRun: false, identityStore },
        logger,
      );

      expect(r.evidenceItems).toBe(6); // 5 baseline + 1 durable identity entry (temporary excluded)
      expect(r.stored).toBe(1);
      const row = db.getRawDb().prepare("SELECT provenance_json FROM facts WHERE category = 'insight'").get() as {
        provenance_json: string;
      };
      const prov = JSON.parse(row.provenance_json);
      expect(prov.sourceIdentityEvidence).toHaveLength(1);
      expect(prov.sourceIdentityEvidence[0].text).toContain("direct, concise updates");
    } finally {
      identityStore.close();
    }
  });

  it("remains fully backward compatible when goalsDir/identityStore are omitted", async () => {
    seedBaseline(Math.floor(Date.now() / 1000));
    const r = await runInsightSynthesis(db, mockOpenai(insightJson([])), cfg, { dryRun: false }, logger);
    expect(r.evidenceItems).toBe(5);
    expect(r.semanticOutcome).toBe("success");
  });
});

describe("research config defaults", () => {
  it("parses defaults: enabled, schedule, trigger policy, delivery none", () => {
    const r = parseResearchConfig({});
    expect(r.enabled).toBe(true);
    expect(r.schedule).toBe("30 3 * * *");
    expect(r.insights).toEqual({ maxPerRun: 2, windowDays: 7, minEvidence: 2, model: undefined });
    expect(r.trigger.minImportance).toBeCloseTo(0.74);
    expect(r.trigger.cooldownDays).toBe(14);
    expect(r.trigger.maxPerNight).toBe(1);
    expect(r.trigger.topicBlocklist).toEqual(["credential", "secret", "security"]);
    expect(r.executor).toEqual({ maxBriefingChars: 4000, maxSources: 8 });
    expect(r.delivery.mode).toBe("none");
    expect(r.delivery.injectDays).toBe(3);
    expect(r.delivery.maxBriefings).toBe(2);
  });

  it("respects overrides and disable", () => {
    const r = parseResearchConfig({
      research: {
        enabled: false,
        schedule: "0 5 * * *",
        trigger: { topicBlocklist: ["Wellbeing "], cooldownDays: 30 },
        delivery: { mode: "announce", channel: "telegram", to: "123", injectDays: 0 },
      },
    });
    expect(r.enabled).toBe(false);
    expect(r.schedule).toBe("0 5 * * *");
    expect(r.trigger.topicBlocklist).toEqual(["wellbeing"]);
    expect(r.trigger.cooldownDays).toBe(30);
    expect(r.delivery).toMatchObject({ mode: "announce", channel: "telegram", to: "123", injectDays: 0 });
  });
});
