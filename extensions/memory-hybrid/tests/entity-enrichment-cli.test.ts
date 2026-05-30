/**
 * CLI entity enrichment: graph gate, limit sanitization, tier priority, --all mode (#992, #1690 review).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FactsDB } from "../backends/facts-db.js";
import { hybridConfigSchema } from "../config.js";
import { runEntityEnrichmentForCli } from "../services/entity-enrichment-cli.js";

describe("runEntityEnrichmentForCli", () => {
  let dir: string;
  let db: FactsDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hybrid-entity-cli-"));
    mkdirSync(dir, { recursive: true });
    db = new FactsDB(join(dir, "facts.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns skipped and does not call the LLM when graph.enabled is false", async () => {
    const openai = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: false },
    });
    const res = await runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 10,
      dryRun: false,
    });
    expect(res.skipped).toBe(true);
    expect(res.totalBacklog).toBeTypeOf("number");
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
  });

  it("returns totalBacklog equal to total pending facts regardless of limit", async () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: false },
    });
    // Store 5 facts long enough to be eligible
    for (let i = 0; i < 5; i++) {
      db.store({
        text: `This is fact number ${i} with enough text to pass the minimum length filter`,
        category: "fact",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "test",
      });
    }
    const res = await runEntityEnrichmentForCli(db, {} as never, cfg, {
      limit: 2,
      dryRun: false,
    });
    expect(res.totalBacklog).toBe(5);
    expect(res.skipped).toBe(true);
  });

  it("countFactIdsNeedingEntityEnrichment returns total pending backlog count", () => {
    for (let i = 0; i < 4; i++) {
      db.store({
        text: `Long enough fact text for enrichment eligibility check number ${i}`,
        category: "fact",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "test",
      });
    }
    expect(db.countFactIdsNeedingEntityEnrichment()).toBe(4);
  });

  it("--all mode returns all pending facts ignoring limit", async () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: false },
    });
    for (let i = 0; i < 8; i++) {
      db.store({
        text: `Fact with sufficient text length for enrichment pipeline processing ${i}`,
        category: "fact",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "test",
      });
    }
    const res = await runEntityEnrichmentForCli(db, {} as never, cfg, {
      limit: 2,
      all: true,
      dryRun: false,
    });
    // With all=true the full backlog should be returned in pending even though limit=2
    expect(res.pending).toBe(8);
    expect(res.totalBacklog).toBe(8);
  });

  it("dry-run with limit returns only batch-size pending, totalBacklog reflects full backlog", async () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: true, neo4jUrl: "bolt://localhost:7687" },
    });
    for (let i = 0; i < 6; i++) {
      db.store({
        text: `Enrichment candidate fact with plenty of text to pass the minimum length filter ${i}`,
        category: "fact",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "test",
      });
    }
    const res = await runEntityEnrichmentForCli(db, {} as never, cfg, {
      limit: 3,
      dryRun: true,
    });
    expect(res.pending).toBe(3);
    expect(res.totalBacklog).toBe(6);
    expect(res.processed).toBe(0);
  });

  it("listFactIdsNeedingEntityEnrichment returns hot facts before cold facts", () => {
    const hot = db.store({
      text: "Hot fact with enough text to exceed the minimum length filter threshold here",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    const cold = db.store({
      text: "Cold fact with enough text to exceed the minimum length filter threshold here",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    db.setTier(cold.id, "cold");
    db.setTier(hot.id, "hot");
    const ids = db.listFactIdsNeedingEntityEnrichment(10, 24);
    const hotIdx = ids.indexOf(hot.id);
    const coldIdx = ids.indexOf(cold.id);
    expect(hotIdx).toBeGreaterThanOrEqual(0);
    expect(coldIdx).toBeGreaterThanOrEqual(0);
    expect(hotIdx).toBeLessThan(coldIdx);
  });
});
