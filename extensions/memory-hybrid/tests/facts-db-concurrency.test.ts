/**
 * Regression coverage for GlitchTip #1465 (SQLITE_BUSY / database is locked).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

describe("FactsDB concurrent writes (#1465)", () => {
  let tmpDir: string;
  let db: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "facts-db-concurrency-"));
    db = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("completes many parallel store() calls without throwing database is locked", async () => {
    const stores = Array.from({ length: 40 }, (_, i) =>
      Promise.resolve().then(() =>
        db.store({
          text: `Concurrent fact ${i}`,
          category: "fact",
          importance: 0.5,
          entity: null,
          key: null,
          value: null,
          source: "concurrency-test",
        }),
      ),
    );
    await expect(Promise.all(stores)).resolves.toBeDefined();
    expect(db.count()).toBe(40);
  });

  it.fails("survives write attempts while another connection holds BEGIN IMMEDIATE (#1465)", async () => {
    const raw = db.getRawDb();
    raw.exec("BEGIN IMMEDIATE");
    const holdMs = 500;
    const release = new Promise<void>((resolve) => {
      setTimeout(() => {
        raw.exec("ROLLBACK");
        resolve();
      }, holdMs);
    });
    try {
      const results = await Promise.all([
        ...Array.from({ length: 10 }, (_, i) =>
          Promise.resolve().then(() => {
            try {
              db.store({
                text: `Blocked write ${i}`,
                category: "fact",
                importance: 0.5,
                entity: null,
                key: null,
                value: null,
                source: "concurrency-test",
              });
              return "ok";
            } catch (err: unknown) {
              return err instanceof Error ? err.message : String(err);
            }
          }),
        ),
        release,
      ]);
      const locked = results.filter(
        (r) => typeof r === "string" && (r.includes("locked") || r.includes("SQLITE_BUSY")),
      );
      expect(locked).toHaveLength(0);
    } catch {
      raw.exec("ROLLBACK");
      throw new Error("unexpected throw from concurrency test");
    }
  });
});
