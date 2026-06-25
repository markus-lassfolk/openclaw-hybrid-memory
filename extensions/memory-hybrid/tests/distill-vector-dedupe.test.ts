import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { filterDistillVectorCandidates } from "../cli/cmd-distill.js";
import { applyDedupe, resolveDedupeProfile } from "../services/dedupe-policy.js";
import { DISTILL_DEDUP_THRESHOLD } from "../utils/constants.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

describe("distill vector dedupe (#1947)", () => {
  let dir: string;
  let db: FactsDB;

  afterEach(() => {
    if (db) db.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("uses the distill cosine threshold in the default dedupe profile", () => {
    const profile = resolveDedupeProfile("distillation", { fuzzyDedupe: true });
    expect(profile.vectorThreshold).toBe(DISTILL_DEDUP_THRESHOLD);
  });

  it("filterDistillVectorCandidates keeps live distillation neighbours only", () => {
    dir = mkdtempSync(join(tmpdir(), "distill-vector-dedupe-"));
    db = new FactsDB(join(dir, "facts.db"));
    const original = db.store({
      text: "Hybrid memory nightly maintenance resolves contradictions automatically",
      category: "project",
      importance: 0.8,
      entity: "hybrid-memory",
      key: "status",
      value: "in_progress",
      source: "distillation",
    });
    const otherSource = db.store({
      text: "Hybrid memory nightly maintenance resolves contradictions automatically",
      category: "project",
      importance: 0.8,
      entity: "hybrid-memory",
      key: "status",
      value: "done",
      source: "conversation",
    });

    const filtered = filterDistillVectorCandidates(
      [
        { entry: { id: original.id }, score: 0.91 },
        { entry: { id: otherSource.id }, score: 0.99 },
        { entry: { id: "missing-id" }, score: 0.95 },
      ],
      db,
      null,
    );

    expect(filtered).toEqual([{ id: original.id, score: 0.91 }]);
  });

  it("applyDedupe skips distillation near-duplicates from vectorCandidates", () => {
    dir = mkdtempSync(join(tmpdir(), "distill-vector-dedupe-"));
    db = new FactsDB(join(dir, "facts.db"));
    const original = db.store({
      text: "PR stewardship queue prioritizes merge-ready PRs before new feature work",
      category: "project",
      importance: 0.8,
      entity: "hybrid-memory-pr-stewardship",
      key: "next",
      value: "merge PR #1600",
      source: "distillation",
    });
    const profile = resolveDedupeProfile("distillation", { fuzzyDedupe: true });
    const dedupe = applyDedupe(
      profile,
      {
        text: "PR stewardship queue should prioritize merge-ready pull requests before feature work",
        source: "distillation",
        scope: "global",
        scopeTarget: null,
        category: "project",
        entity: "hybrid-memory-pr-stewardship",
        key: "next",
        value: "merge PR #1600 next",
      },
      {
        db: db.getRawDb(),
        nowSec: Math.floor(Date.now() / 1000),
        fuzzyDedupe: true,
        vectorCandidates: [{ id: original.id, score: 0.88 }],
      },
    );

    expect(dedupe.action).toBe("skip");
    if (dedupe.action === "skip") {
      expect(dedupe.existingId).toBe(original.id);
      expect(dedupe.reason).toBe("vector");
    }
  });

  it("skips near-duplicate distillation facts via vectorCandidates in storeWithResult", () => {
    dir = mkdtempSync(join(tmpdir(), "distill-vector-dedupe-"));
    db = new FactsDB(join(dir, "facts.db"), {
      fuzzyDedupe: true,
      storeConfig: { fuzzyDedupe: true },
    });
    const original = db.store({
      text: "PR stewardship queue prioritizes merge-ready PRs before new feature work",
      category: "project",
      importance: 0.8,
      entity: "hybrid-memory-pr-stewardship",
      key: "next",
      value: "merge PR #1600",
      source: "distillation",
    });

    const result = db.storeWithResult(
      {
        text: "PR stewardship queue should prioritize merge-ready pull requests before feature work",
        category: "project",
        importance: 0.8,
        entity: "hybrid-memory-pr-stewardship",
        key: "next",
        value: "merge PR #1600 next",
        source: "distillation",
      },
      { vectorCandidates: [{ id: original.id, score: 0.88 }] },
    );

    expect(result.newlyStored).toBe(false);
    expect(result.entry.id).toBe(original.id);
    expect(db.count()).toBe(1);
  });
});
