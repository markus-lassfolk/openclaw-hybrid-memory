import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { NarrativesDB } from "../backends/narratives-db.js";
import { buildPublicExportBundle } from "../services/public-export-bundle.js";

describe("buildPublicExportBundle", () => {
  let tmp: string;
  let factsDb: FactsDB;
  let narrativesDb: NarrativesDB;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "public-export-"));
    factsDb = new FactsDB(join(tmp, "facts.db"));
    narrativesDb = new NarrativesDB(join(tmp, "narratives.db"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("includes facts, episodes, procedures, narratives and provenance metadata", () => {
    const factA = factsDb.store({
      text: "User likes concise summaries",
      category: "preference",
      importance: 0.9,
      entity: "user",
      key: "style",
      value: "concise",
      source: "conversation",
    });

    const factB = factsDb.store({
      text: "Use sqlite for local-first metadata",
      category: "decision",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "distillation",
    });

    factsDb.createLink(factA.id, factB.id, "RELATED_TO", 0.7);

    factsDb.recordEpisode({
      event: "Ran nightly memory maintenance",
      outcome: "success",
      relatedFactIds: [factA.id],
    });

    factsDb.upsertProcedure({
      taskPattern: "Run nightly maintenance",
      recipeJson: JSON.stringify([{ tool: "memory_prune", args: { mode: "both" } }]),
      procedureType: "positive",
      confidence: 0.9,
      ttlDays: 30,
    });

    narrativesDb.store({
      sessionId: "session-1",
      periodStart: Math.floor(Date.now() / 1000) - 60,
      periodEnd: Math.floor(Date.now() / 1000),
      tag: "session",
      narrativeText: "Completed maintenance and validated outputs.",
    });

    const bundle = buildPublicExportBundle(factsDb, narrativesDb, {
      factsLimit: 10,
      episodesLimit: 10,
      proceduresLimit: 10,
      narrativesLimit: 10,
      linksLimit: 10,
    });

    expect(bundle.manifest.bundleVersion).toBe(1);
    expect(bundle.version.pluginVersion).toBeTruthy();
    expect(bundle.facts.length).toBeGreaterThanOrEqual(2);
    expect(bundle.episodes.length).toBe(1);
    expect(bundle.procedures.length).toBe(1);
    expect(bundle.narratives.length).toBe(1);
    expect(bundle.provenance.links.length).toBeGreaterThanOrEqual(1);
    expect(bundle.provenance.bySource.conversation).toBeGreaterThanOrEqual(1);
  });

  it("respects per-section limits", () => {
    for (let i = 0; i < 5; i += 1) {
      factsDb.store({
        text: `Fact ${i}`,
        category: "fact",
        importance: 0.6,
        entity: null,
        key: null,
        value: null,
        source: "conversation",
      });
    }

    const bundle = buildPublicExportBundle(factsDb, narrativesDb, {
      factsLimit: 2,
      episodesLimit: 2,
      proceduresLimit: 2,
      narrativesLimit: 2,
      linksLimit: 2,
    });

    expect(bundle.facts).toHaveLength(2);
    expect(bundle.manifest.limits.facts).toBe(2);
  });
});
