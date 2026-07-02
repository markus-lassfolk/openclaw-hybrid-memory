/**
 * Regression test for #85: storeFact() swallowed resolveEntityForeignKeys() failures with a bare
 * empty catch block, giving no visibility into entity-linkage gaps. It now reports the failure
 * via capturePluginError while still treating it as non-fatal to the store itself.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import * as entityLayer from "../backends/facts-db/entity-layer.js";
import * as errorReporter from "../services/error-reporter.js";

const { FactsDB } = _testing;

describe("storeFact reports resolveEntityForeignKeys failures (#85)", () => {
  let tmpDir: string;
  let db: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "store-fact-entity-fk-"));
    db = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("stores the fact and reports the failure via capturePluginError when entity FK resolution throws", () => {
    const captureSpy = vi.spyOn(errorReporter, "capturePluginError").mockImplementation(() => undefined);
    vi.spyOn(entityLayer, "resolveEntityForeignKeys").mockImplementation(() => {
      throw new Error("entity fk boom");
    });

    const entry = db.store({
      text: "Fact whose entity FK resolution will fail",
      category: "entity",
      importance: 0.6,
      entity: "Someone Important",
      key: null,
      value: null,
      source: "test",
    });

    // Non-fatal: the fact itself is still stored and readable.
    expect(entry.id).toBeTruthy();
    expect(db.getById(entry.id)?.text).toBe("Fact whose entity FK resolution will fail");

    const fkFailureCalls = captureSpy.mock.calls.filter(
      ([, ctx]) => ctx?.operation === "resolve-entity-foreign-keys",
    );
    expect(fkFailureCalls).toHaveLength(1);
    expect(fkFailureCalls[0][1]).toMatchObject({
      subsystem: "facts-db",
      severity: "warning",
      tags: { factId: entry.id, entity: "Someone Important" },
    });
  });

  it("does not report when resolveEntityForeignKeys succeeds", () => {
    const captureSpy = vi.spyOn(errorReporter, "capturePluginError").mockImplementation(() => undefined);

    db.store({
      text: "Fact with normal entity FK resolution",
      category: "entity",
      importance: 0.6,
      entity: "Another Person",
      key: null,
      value: null,
      source: "test",
    });

    const fkFailureCalls = captureSpy.mock.calls.filter(
      ([, ctx]) => ctx?.operation === "resolve-entity-foreign-keys",
    );
    expect(fkFailureCalls).toHaveLength(0);
  });
});
