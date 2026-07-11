/**
 * Proactive research loop A1: insight synthesis. The LLM only ever cites numbered evidence refs
 * (F#/S#) that the service maps back to real fact/signal ids — hallucinated evidence is dropped
 * wholesale, insights dedupe by slug entity, and caps/windows are enforced deterministically.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { parseResearchConfig } from "../config/parsers/research.js";
import { runInsightSynthesis, slugifyInsight } from "../services/insight-synthesis.js";

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
