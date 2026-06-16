/**
 * Tests for issues #1901–#1904 features.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import {
  acquireLease,
  releaseAllLeasesForSession,
  releaseLease,
} from "../services/worker-lease.js";
import { searchFts } from "../services/fts-search.js";
import { buildEpisodeCausalChain } from "../services/episode-causal-inference.js";
import { scoreFactContradiction, repairUndetectedContradictions } from "../backends/facts-db/contradictions.js";
import { parseRetrievalConfig } from "../config/parsers/retrieval.js";

const { FactsDB } = _testing;

let tmpDir: string;
let db: InstanceType<typeof FactsDB>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "issues-1901-1904-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("worker leases (#1904)", () => {
  it("allows only one concurrent lease holder", () => {
    const raw = db.getRawDb();
    const a = acquireLease(raw, "crystallization", "session-a", { ttlSeconds: 120 });
    const b = acquireLease(raw, "crystallization", "session-b", { ttlSeconds: 120 });
    expect(a).toBe(true);
    expect(b).toBe(false);
    expect(releaseLease(raw, "crystallization", "session-a")).toBe(true);
    const c = acquireLease(raw, "crystallization", "session-b", { ttlSeconds: 120 });
    expect(c).toBe(true);
    releaseAllLeasesForSession(raw, "session-b");
  });
});

describe("keyword recall (#1901)", () => {
  it("finds exact phrase via FTS5", () => {
    db.store({
      text: "Policy FR-2024-LIC-027 requires quarterly audit",
      category: "fact",
      importance: 0.7,
      source: "conversation",
    });
    const hits = searchFts(db.getRawDb(), "FR-2024-LIC-027", { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text).toContain("FR-2024-LIC-027");
  });
});

describe("recall mode config (#1901 risk 3)", () => {
  it("defaults to semantic for backward compatibility", () => {
    const cfg = parseRetrievalConfig({});
    expect(cfg.defaultRecallMode).toBe("semantic");
  });

  it("allows hybrid via config", () => {
    const cfg = parseRetrievalConfig({ retrieval: { defaultRecallMode: "hybrid" } });
    expect(cfg.defaultRecallMode).toBe("hybrid");
  });
});

describe("contradiction surface (#1902)", () => {
  it("scores entity+key value mismatch with heuristic signals", () => {
    const score = scoreFactContradiction(
      "timeout is 30 seconds",
      "30",
      "timeout is 60 seconds",
      "60",
    );
    expect(score.score).toBeGreaterThan(0);
    expect(score.heuristicSignals).toContain("numeric_conflict");
  });

  it("records enriched contradiction metadata on store", () => {
    const old = db.store({
      text: "Caching enabled",
      category: "decision",
      entity: "gateway",
      key: "caching",
      value: "enabled",
      importance: 0.8,
      source: "conversation",
    });
    const neu = db.store({
      text: "Caching disabled",
      category: "decision",
      entity: "gateway",
      key: "caching",
      value: "disabled",
      importance: 0.8,
      source: "conversation",
    });
    const hits = db.detectContradictions(neu.id, "gateway", "caching", "disabled", null, null, "Caching disabled");
    expect(hits.length).toBe(1);
    expect(hits[0]?.oldFactId).toBe(old.id);
    expect(hits[0]?.score).toBeGreaterThan(0);
    expect(hits[0]?.preview.length).toBeGreaterThan(0);

    const surface = db.queryContradictionSurface({ resolved: false, limit: 10 });
    expect(surface.some((s) => s.contradictionId === hits[0]?.contradictionId)).toBe(true);
  });

  it("repairUndetectedContradictions backfills missing rows (#1902 risk 2)", () => {
    db.store({
      text: "Theme dark",
      category: "fact",
      entity: "user",
      key: "theme",
      value: "dark",
      importance: 0.7,
      source: "conversation",
    });
    db.store({
      text: "Theme light",
      category: "fact",
      entity: "user",
      key: "theme",
      value: "light",
      importance: 0.7,
      source: "conversation",
    });

    const repair = repairUndetectedContradictions(
      db.getRawDb(),
      (a, b, t, s) => db.createLink(a, b, t, s ?? 1.0),
      50,
    );
    expect(repair.pairsRepaired).toBeGreaterThan(0);
    expect(repair.pairsFailed).toBe(0);
    expect(repair.pairsFallback).toBe(0);
    expect(db.queryContradictionSurface({ resolved: false, limit: 10 }).length).toBeGreaterThan(0);
  });
});

describe("episode causal chain (#1903)", () => {
  it("links episodes with shared tags and divergent outcomes", () => {
    const now = Math.floor(Date.now() / 1000);
    const sharedFact = db.store({
      text: "Deploy gateway v2",
      category: "procedure",
      entity: "gateway",
      key: "deploy",
      value: "v2",
      importance: 0.8,
      source: "conversation",
    });

    const prior = db.recordEpisodeWithCausalLinks({
      event: "deploy gateway v2",
      outcome: "success",
      timestamp: now - 3600,
      tags: ["gateway", "deploy"],
      relatedFactIds: [sharedFact.id],
    }).episode;

    const failure = db.recordEpisodeWithCausalLinks({
      event: "gateway deploy failed after config change",
      outcome: "failure",
      timestamp: now,
      tags: ["gateway", "deploy"],
      relatedFactIds: [sharedFact.id],
    });

    expect(failure.causallyInferredLinks.length).toBeGreaterThan(0);
    const chain = buildEpisodeCausalChain(db.getRawDb(), failure.episode.id, 5, false);
    expect(chain.some((c) => c.episodeId === prior.id)).toBe(true);
  });
});
