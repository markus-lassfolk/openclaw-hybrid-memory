/**
 * cmd-backfill session JSONL parsing boundaries (#1472, #1474).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractUserMessageTextsFromSessionJsonl } from "../cli/cmd-backfill.js";

describe("extractUserMessageTextsFromSessionJsonl", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "backfill-jsonl-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips malformed JSONL lines and returns valid user message text", () => {
    const path = join(tmpDir, "session.jsonl");
    writeFileSync(
      path,
      [
        "{ not valid json",
        JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "  Remember this fact  " }] },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "Sure." }] },
        }),
      ].join("\n"),
      "utf8",
    );

    expect(extractUserMessageTextsFromSessionJsonl(path)).toEqual(["Remember this fact"]);
  });

  it("returns empty array when every line is malformed", () => {
    const path = join(tmpDir, "only-bad.jsonl");
    writeFileSync(path, ["{", "not-json", ""].join("\n"), "utf8");
    expect(extractUserMessageTextsFromSessionJsonl(path)).toEqual([]);
  });
});
