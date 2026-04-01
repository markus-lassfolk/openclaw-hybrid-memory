import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EdictStore } from "../backends/edict-store.js";

describe("EdictStore", () => {
  let dir: string;
  let store: EdictStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "edict-store-test-"));
    store = new EdictStore(join(dir, "edicts.db"));
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // ignore
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("list and getEdicts work after migrations", () => {
    store.add({ text: "Verified fact one", tags: ["ops"] });
    expect(store.list()).toHaveLength(1);
    const g = store.getEdicts({ format: "prompt" });
    expect(g.edicts).toHaveLength(1);
    expect(g.renderForPrompt).toContain("Verified fact one");
  });

  it("returns empty reads when _isReady is false (issue #964)", () => {
    (store as unknown as { _isReady: boolean })._isReady = false;
    expect(store.list()).toEqual([]);
    expect(store.getEdicts({ format: "prompt" })).toEqual({ edicts: [], renderForPrompt: "" });
    expect(store.getEdicts({ format: "full" })).toEqual({ edicts: [], renderForPrompt: "" });
  });
});
