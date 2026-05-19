/**
 * Shared setup for VectorDB test suites (split from vector-db-schema.test.ts).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorDB } from "../../backends/vector-db.js";
import * as errorReporter from "../../services/error-reporter.js";

export { VectorDB };

export const CORRECT_DIM = 3;
export const WRONG_DIM = 5;

export async function seedTable(lanceDir: string, dim: number): Promise<void> {
  const seeder = new VectorDB(lanceDir, dim);
  await seeder.store({
    text: "seed fact",
    vector: new Array(dim).fill(0.1),
    importance: 0.8,
    category: "fact",
  });
  seeder.close();
}

export {
  randomUUID,
  mkdtempSync,
  rmSync,
  tmpdir,
  join,
  lancedb,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  errorReporter,
};
