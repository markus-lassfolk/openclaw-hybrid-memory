/**
 * Regression tests for #77: classify-batch previously zipped the LLM's response array to the
 * input facts purely by array position, verified only by `.length`. A response that reorders,
 * duplicates, or drops an entry while keeping the same length would silently apply a category
 * to the wrong fact. classifyBatch now keys each response entry by an explicit "n" (the fact's
 * 1-based position in the prompt) instead of trusting array order.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import { runAutoClassify } from "../services/auto-classifier.js";

const { FactsDB } = _testing;

const noop = { info: () => {}, warn: () => {} };

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-alignment-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function storeOther(factsDb: InstanceType<typeof FactsDB>, label: string): void {
  factsDb.store({
    text: `other fact about ${label}`,
    category: "other",
    importance: 0.5,
    entity: null,
    key: null,
    value: null,
    source: "test",
  });
}

function mockClassifyResponse(entries: Array<{ n: number; category: string }>): unknown {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(entries) } }],
        }),
      },
    },
  };
}

describe("classifyBatch response alignment (#77)", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    factsDb?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies each category to the fact matching its declared 'n', not its position in the response array", async () => {
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    storeOther(factsDb, "alpha");
    storeOther(factsDb, "beta");
    storeOther(factsDb, "gamma");
    const batchOrder = [...factsDb.getUnattemptedOtherFacts()];
    expect(batchOrder).toHaveLength(3);

    // Response entries are keyed by 'n' (batchOrder[i] ↔ n=i+1) but the ARRAY ORDER is
    // deliberately shuffled — a naive positional zip would assign "decision" (declared for
    // n=3) to batchOrder[0] instead of batchOrder[2].
    const openai = mockClassifyResponse([
      { n: 3, category: "decision" },
      { n: 1, category: "fact" },
      { n: 2, category: "entity" },
    ]);

    const result = await runAutoClassify(
      factsDb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai as any,
      { model: "test-model", batchSize: 20 },
      noop,
      { openclawDir: tmpDir },
    );

    expect(result.reclassified).toBe(3);
    expect(factsDb.getById(batchOrder[0].id)?.category).toBe("fact");
    expect(factsDb.getById(batchOrder[1].id)?.category).toBe("entity");
    expect(factsDb.getById(batchOrder[2].id)?.category).toBe("decision");
  });

  it("skips a fact rather than applying a category when its 'n' is duplicated in the response", async () => {
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    storeOther(factsDb, "one");
    storeOther(factsDb, "two");
    const batchOrder = [...factsDb.getUnattemptedOtherFacts()];
    expect(batchOrder).toHaveLength(2);

    // n=1 appears twice (with conflicting categories) and n=2 never appears — array length
    // still matches facts.length (2), so the coarse length check alone would accept this.
    // The first n=1 occurrence wins; the fact at n=2 is left unclassified rather than
    // receiving the leftover/duplicate entry via a positional fallback.
    const openai = mockClassifyResponse([
      { n: 1, category: "fact" },
      { n: 1, category: "decision" },
    ]);

    const result = await runAutoClassify(
      factsDb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai as any,
      { model: "test-model", batchSize: 20 },
      noop,
      { openclawDir: tmpDir },
    );

    expect(result.reclassified).toBe(1);
    expect(factsDb.getById(batchOrder[0].id)?.category).toBe("fact");
    expect(factsDb.getById(batchOrder[1].id)?.category).toBe("other");
  });

  it("ignores a response entry whose 'n' is out of range for the batch", async () => {
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    storeOther(factsDb, "solo");
    storeOther(factsDb, "duo");
    const batchOrder = [...factsDb.getUnattemptedOtherFacts()];
    expect(batchOrder).toHaveLength(2);

    // Array length matches facts.length (2) so the coarse length check still passes, but n=99
    // is out of range for this batch and must be dropped rather than applied via fallback
    // positional indexing.
    const openai = mockClassifyResponse([
      { n: 99, category: "decision" },
      { n: 1, category: "entity" },
    ]);

    const result = await runAutoClassify(
      factsDb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai as any,
      { model: "test-model", batchSize: 20 },
      noop,
      { openclawDir: tmpDir },
    );

    expect(result.reclassified).toBe(1);
    expect(factsDb.getById(batchOrder[0].id)?.category).toBe("entity");
    expect(factsDb.getById(batchOrder[1].id)?.category).toBe("other");
  });
});
