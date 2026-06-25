import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  filterDistillVectorCandidates,
  resolveDistillVectorCandidates,
} from "../cli/vector-dedupe-helpers.js";
import { applyDedupe, resolveDedupeProfile } from "../services/dedupe-policy.js";
import { DISTILL_DEDUP_THRESHOLD } from "../utils/constants.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

describe("distill vector dedupe (#1947)", () => {
  let dir: string;
  let db: InstanceType<typeof FactsDB>;

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

  it("applyDedupe skips distillation near-duplicates even when entity slug drifted", () => {
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
        entity: "hybrid-memory-pr-stewardship-current-state",
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
        entity: "hybrid-memory-pr-stewardship-current-state",
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

  it("does not vector-dedupe distillation project facts across unrelated entities with the same key", () => {
    dir = mkdtempSync(join(tmpdir(), "distill-vector-dedupe-"));
    db = new FactsDB(join(dir, "facts.db"));
    const original = db.store({
      text: "Hybrid memory maintenance resolves contradictions automatically",
      category: "project",
      importance: 0.8,
      entity: "hybrid-memory",
      key: "status",
      value: "in_progress",
      source: "distillation",
    });
    const profile = resolveDedupeProfile("distillation", { fuzzyDedupe: true });
    const dedupe = applyDedupe(
      profile,
      {
        text: "Humanizer pipeline maintenance resolves contradictions automatically overnight",
        source: "distillation",
        scope: "global",
        scopeTarget: null,
        category: "project",
        entity: "humanizer",
        key: "status",
        value: "in_progress",
      },
      {
        db: db.getRawDb(),
        nowSec: Math.floor(Date.now() / 1000),
        fuzzyDedupe: true,
        vectorCandidates: [{ id: original.id, score: 0.95 }],
      },
    );

    expect(dedupe.action).toBe("store");
  });

  it("does not vector-dedupe distillation project facts across different keys", () => {
    dir = mkdtempSync(join(tmpdir(), "distill-vector-dedupe-"));
    db = new FactsDB(join(dir, "facts.db"));
    const original = db.store({
      text: "Hybrid memory maintenance resolves contradictions automatically",
      category: "project",
      importance: 0.8,
      entity: "hybrid-memory",
      key: "status",
      value: "in_progress",
      source: "distillation",
    });
    const profile = resolveDedupeProfile("distillation", { fuzzyDedupe: true });
    const dedupe = applyDedupe(
      profile,
      {
        text: "Hybrid memory maintenance resolves contradictions automatically overnight",
        source: "distillation",
        scope: "global",
        scopeTarget: null,
        category: "project",
        entity: "hybrid-memory-current-state",
        key: "next",
        value: "resolve contradictions",
      },
      {
        db: db.getRawDb(),
        nowSec: Math.floor(Date.now() / 1000),
        fuzzyDedupe: true,
        vectorCandidates: [{ id: original.id, score: 0.95 }],
      },
    );

    expect(dedupe.action).toBe("store");
  });

  it("does not vector-dedupe when entity slugs share only a shallow prefix", () => {
    dir = mkdtempSync(join(tmpdir(), "distill-vector-dedupe-prefix-"));
    db = new FactsDB(join(dir, "facts.db"));
    const original = db.store({
      text: "Hybrid memory maintenance resolves contradictions automatically",
      category: "project",
      importance: 0.8,
      entity: "hybrid-memory-maintenance",
      key: "status",
      value: "in_progress",
      source: "distillation",
    });
    const profile = resolveDedupeProfile("distillation", { fuzzyDedupe: true });
    const dedupe = applyDedupe(
      profile,
      {
        text: "Hybrid memory other project maintenance resolves contradictions automatically overnight",
        source: "distillation",
        scope: "global",
        scopeTarget: null,
        category: "project",
        entity: "hybrid-memory-other-project",
        key: "status",
        value: "in_progress",
      },
      {
        db: db.getRawDb(),
        nowSec: Math.floor(Date.now() / 1000),
        fuzzyDedupe: true,
        vectorCandidates: [{ id: original.id, score: 0.95 }],
      },
    );
    expect(dedupe.action).toBe("store");
  });

  it("resolveDistillVectorCandidates returns filtered candidates for storeWithResult wiring", async () => {
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

    const result = await resolveDistillVectorCandidates({
      fuzzyDedupe: true,
      vector: [0.1, 0.2, 0.3],
      vectorDb: {
        search: async () => [{ entry: { id: original.id }, score: 0.91 }],
        hasDuplicate: async () => false,
      },
      factsDb: db,
      embeddingModelName: null,
    });

    expect(result.vectorSearchDegraded).toBe(false);
    expect(result.vectorCandidates).toEqual([{ id: original.id, score: 0.91 }]);
    expect(result.skipAsDuplicate).toBe(false);
  });
});
