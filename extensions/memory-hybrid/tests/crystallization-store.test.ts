import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrystallizationStore } from "../backends/crystallization-store.js";

let tmpDir: string;
let cStore: CrystallizationStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "crystallization-store-test-"));
  cStore = new CrystallizationStore(join(tmpDir, "crystallization-proposals.db"));
});

afterEach(() => {
  cStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("CrystallizationStore.list", () => {
  it("treats skillName LIKE wildcards as literal characters (#1454)", () => {
    cStore.create({
      patternId: "p-wildcard-percent",
      evidenceHash: "ev-wildcard-percent",
      skillName: "deploy%literal",
      skillContent: "#c",
      patternSnapshot: "{}",
    });
    cStore.create({
      patternId: "p-wildcard-underscore",
      evidenceHash: "ev-wildcard-underscore",
      skillName: "deploy_literal",
      skillContent: "#c",
      patternSnapshot: "{}",
    });
    cStore.create({
      patternId: "p-wildcard-backslash",
      evidenceHash: "ev-wildcard-backslash",
      skillName: "deploy\\literal",
      skillContent: "#c",
      patternSnapshot: "{}",
    });

    expect(cStore.list({ skillName: "%literal" }).map((p) => p.skillName)).toEqual(["deploy%literal"]);
    expect(cStore.list({ skillName: "_literal" }).map((p) => p.skillName)).toEqual(["deploy_literal"]);
    expect(cStore.list({ skillName: "\\literal" }).map((p) => p.skillName)).toEqual(["deploy\\literal"]);
  });
});
