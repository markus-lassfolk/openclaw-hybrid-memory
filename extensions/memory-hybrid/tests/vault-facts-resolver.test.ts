/**
 * Vault-facts SPO resolver tests (#1912).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { resolveVaultFactsTriples, resolveVaultFactsTriplesMulti } from "../services/vault-facts-resolver.js";

describe("resolveVaultFactsTriplesMulti", () => {
  let tmpDir: string;
  let defaultDb: FactsDB;
  let secondaryDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-vault-spo-"));
    defaultDb = new FactsDB(join(tmpDir, "default.db"), { fuzzyDedupe: false, storeConfig: {} });
    secondaryDb = new FactsDB(join(tmpDir, "work.db"), { fuzzyDedupe: false, storeConfig: {} });
  });

  afterEach(() => {
    defaultDb.close();
    secondaryDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when no vault has entity layer data", () => {
    expect(resolveVaultFactsTriplesMulti([defaultDb, secondaryDb], "Acme Corporation status")).toEqual([]);
  });

  it("finds triples from a secondary vault when default vault is empty", () => {
    const fact = secondaryDb.store({
      text: "Acme Corporation confirmed the API deadline for the integration project.",
      entity: "Acme Corporation",
      key: "deadline",
      value: "2026-07-01",
      category: "fact",
      importance: 0.6,
      source: "test",
    });
    secondaryDb.applyEntityEnrichment(
      fact.id,
      [
        {
          label: "ORG",
          surfaceText: "Acme Corporation",
          normalizedSurface: "acme corporation",
          startOffset: 0,
          endOffset: 16,
          confidence: 0.9,
        },
      ],
      "eng",
    );

    const defaultTriples = resolveVaultFactsTriples(defaultDb, "Tell me about Acme Corporation");
    expect(defaultTriples).toEqual([]);

    const merged = resolveVaultFactsTriplesMulti([defaultDb, secondaryDb], "Tell me about Acme Corporation");
    expect(merged.some((t) => t.subject === "Acme Corporation" && t.predicate === "deadline")).toBe(true);
  });
});
