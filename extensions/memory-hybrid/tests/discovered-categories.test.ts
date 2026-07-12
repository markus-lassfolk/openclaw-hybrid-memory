// @ts-nocheck
/**
 * Regression tests for #2100: `.discovered-categories.json` had no review workflow — the
 * bootstrap warning pointed at a raw JSON file with no way to list, approve, or reject entries.
 * decideDiscoveredCategory owns the approve/reject state as sibling files next to the pending
 * one, without changing auto-classifier.ts's existing pending-file read/write shape.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import { runAutoClassify } from "../services/auto-classifier.js";
import {
  decideDiscoveredCategory,
  getDiscoveredCategoriesRejectedPath,
  readPendingDiscoveredCategories,
  readRejectedDiscoveredCategories,
} from "../services/discovered-categories.js";

const { FactsDB } = _testing;

let tmpDir: string;
let discoveredPath: string;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), "hm-discovered-categories-"));
  discoveredPath = join(tmpDir, ".discovered-categories.json");
}

describe("readPendingDiscoveredCategories / readRejectedDiscoveredCategories", () => {
  it("returns an empty array when the pending file does not exist", () => {
    setup();
    expect(readPendingDiscoveredCategories(discoveredPath)).resolves.toEqual([]);
  });

  it("reads the flat string[] pending file written by auto-classifier.ts's own writer", () => {
    setup();
    writeFileSync(discoveredPath, JSON.stringify(["invoices", "travel"]), "utf-8");
    return expect(readPendingDiscoveredCategories(discoveredPath)).resolves.toEqual(["invoices", "travel"]);
  });

  it("getDiscoveredCategoriesRejectedPath is a sibling file next to the pending one", () => {
    expect(getDiscoveredCategoriesRejectedPath("/x/.discovered-categories.json")).toBe(
      "/x/.discovered-categories-rejected.json",
    );
  });

  it("returns an empty array when the rejected file does not exist", () => {
    setup();
    return expect(readRejectedDiscoveredCategories(discoveredPath)).resolves.toEqual([]);
  });
});

describe("decideDiscoveredCategory (#2100)", () => {
  it("approve removes the label from pending and does not touch the rejected file", async () => {
    setup();
    writeFileSync(discoveredPath, JSON.stringify(["invoices", "travel"]), "utf-8");

    const decision = await decideDiscoveredCategory(discoveredPath, "invoices", "approve");
    expect(decision).toBe("approved");
    expect(await readPendingDiscoveredCategories(discoveredPath)).toEqual(["travel"]);
    expect(await readRejectedDiscoveredCategories(discoveredPath)).toEqual([]);
  });

  it("reject removes the label from pending AND records it in the rejected sidecar", async () => {
    setup();
    writeFileSync(discoveredPath, JSON.stringify(["invoices", "travel"]), "utf-8");

    const decision = await decideDiscoveredCategory(discoveredPath, "invoices", "reject");
    expect(decision).toBe("rejected");
    expect(await readPendingDiscoveredCategories(discoveredPath)).toEqual(["travel"]);
    expect(await readRejectedDiscoveredCategories(discoveredPath)).toEqual(["invoices"]);
  });

  it("returns not-pending and makes no changes for a label that isn't in the pending queue", async () => {
    setup();
    writeFileSync(discoveredPath, JSON.stringify(["travel"]), "utf-8");

    const decision = await decideDiscoveredCategory(discoveredPath, "nonexistent", "reject");
    expect(decision).toBe("not-pending");
    expect(await readPendingDiscoveredCategories(discoveredPath)).toEqual(["travel"]);
    expect(await readRejectedDiscoveredCategories(discoveredPath)).toEqual([]);
  });

  it("rejecting the same label twice does not duplicate it in the rejected sidecar", async () => {
    setup();
    writeFileSync(discoveredPath, JSON.stringify(["invoices"]), "utf-8");
    await decideDiscoveredCategory(discoveredPath, "invoices", "reject");

    // Simulate the label being re-proposed and rejected again.
    writeFileSync(discoveredPath, JSON.stringify(["invoices"]), "utf-8");
    await decideDiscoveredCategory(discoveredPath, "invoices", "reject");

    expect(await readRejectedDiscoveredCategories(discoveredPath)).toEqual(["invoices"]);
  });

  it("leaves the pending file's flat string[] shape intact for auto-classifier.ts's own reader", async () => {
    setup();
    writeFileSync(discoveredPath, JSON.stringify(["invoices", "travel", "misc"]), "utf-8");

    await decideDiscoveredCategory(discoveredPath, "travel", "approve");

    const raw = JSON.parse(readFileSync(discoveredPath, "utf-8"));
    expect(Array.isArray(raw)).toBe(true);
    expect(raw).toEqual(["invoices", "misc"]);
  });
});

describe("rejected labels are never re-proposed by discovery (#2100)", () => {
  let factsDbDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  afterEach(() => {
    factsDb?.close();
    if (factsDbDir) rmSync(factsDbDir, { recursive: true, force: true });
  });

  it("excludes a previously-rejected label from the pending file even when the LLM proposes it again", async () => {
    factsDbDir = mkdtempSync(join(tmpdir(), "hm-discovered-categories-discover-"));
    factsDb = new FactsDB(join(factsDbDir, "facts.db"));
    const discoveredPath = join(factsDbDir, "discovered-categories.json");

    // 16 "other" facts, all pre-marked as classify-attempted so runAutoClassify's classify phase
    // (a separate LLM call path) short-circuits with 0 unattempted facts, isolating this test to
    // the discovery phase only.
    const ids: string[] = [];
    for (let i = 0; i < 16; i++) {
      const entry = factsDb.store({
        text: `other fact ${i}: an invoice-related note`,
        category: "other",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "test",
      });
      ids.push(entry.id);
    }
    factsDb.markClassifyAttempt(ids);

    // Reject "invoices" ahead of time, as if an operator already dismissed it.
    writeFileSync(getDiscoveredCategoriesRejectedPath(discoveredPath), JSON.stringify(["invoices"]), "utf-8");

    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [{ message: { content: JSON.stringify(Array(16).fill("invoices")) } }],
          })),
        },
      },
    };

    await runAutoClassify(
      factsDb,
      mockOpenai as never,
      { model: "test-model", batchSize: 20, suggestCategories: true, minFactsForNewCategory: 10 },
      { info: () => {}, warn: () => {} },
      { discoveredCategoriesPath: discoveredPath, openclawDir: factsDbDir },
    );

    // The LLM proposed "invoices" with enough supporting facts to normally qualify, but it was
    // already rejected — it must not reappear in the pending queue.
    expect(await readPendingDiscoveredCategories(discoveredPath)).not.toContain("invoices");
  });
});
