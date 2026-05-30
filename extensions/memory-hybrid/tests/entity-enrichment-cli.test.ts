/**
 * CLI entity enrichment: graph gate and limit sanitization (#992 review).
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
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
  });

  it("reports backlog/eta for bounded dry-run mode", async () => {
    for (let i = 0; i < 5; i++) {
      db.store({
        text: `Bounded dry-run fact ${i} with enough length for queue planning and enrichment backlog tests.`,
        entity: null,
        key: null,
        value: null,
        category: "other",
        importance: 0.5,
        source: "test",
      });
    }

    const openai = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: true },
    });

    const res = await runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 2,
      dryRun: true,
    });

    expect(res.mode).toBe("bounded");
    expect(res.pending).toBe(2);
    expect(res.pendingTotal).toBe(5);
    expect(res.remainingTotal).toBe(5);
    expect(res.estimatedRunsRemaining).toBe(3);
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
  });

  it("supports --all catch-up mode and processes full backlog even with small limit", async () => {
    for (let i = 0; i < 3; i++) {
      db.store({
        text: `All-mode fact ${i} with sufficient length to force LLM extraction path for enrichment queue checks.`,
        entity: null,
        key: null,
        value: null,
        category: "other",
        importance: 0.5,
        source: "test",
      });
    }

    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '{"mentions":[]}' } }],
          }),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: true },
    });

    const res = await runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 1,
      all: true,
      dryRun: false,
      model: "openai/gpt-4.1-nano",
    });

    expect(res.mode).toBe("all");
    expect(res.effectiveLimit).toBe("all");
    expect(res.pending).toBe(3);
    expect(res.pendingTotal).toBe(3);
    expect(res.processed).toBe(3);
    expect(res.remainingTotal).toBe(0);
    expect(res.estimatedRunsRemaining).toBe(0);
    expect(openai.chat.completions.create).toHaveBeenCalledTimes(3);
  });
});
