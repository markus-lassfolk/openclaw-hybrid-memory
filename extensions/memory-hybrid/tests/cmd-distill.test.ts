import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { extractTextFromSessionJsonl } from "../cli/distill-session-jsonl.js";

describe("extractTextFromSessionJsonl", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores non-object JSON lines and still extracts valid message text", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-distill-jsonl-"));
    tmpDirs.push(dir);
    const filePath = join(dir, "session.jsonl");
    writeFileSync(
      filePath,
      [
        `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"keep me"}]}}`,
        "null",
        '"string-value"',
        "123",
        "{ malformed json",
      ].join("\n"),
      "utf-8",
    );

    expect(() => extractTextFromSessionJsonl(filePath)).not.toThrow();
    expect(extractTextFromSessionJsonl(filePath)).toBe("keep me");
  });
});
