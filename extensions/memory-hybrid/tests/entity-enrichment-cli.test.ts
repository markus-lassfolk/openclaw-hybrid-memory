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
});
