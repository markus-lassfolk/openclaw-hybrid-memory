import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { classifyDistillBatchFailureKind, filterSessionFilesByAllowlist } from "../cli/cmd-distill.js";
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

describe("classifyDistillBatchFailureKind", () => {
  it("treats nested MiniMax aborts as retryable timeout failures", () => {
    const abortCause = Object.assign(new Error("Request was aborted"), { name: "AbortError" });
    const wrapped = Object.assign(new Error("stream error from minimax/MiniMax-M2.7-highspeed"), {
      cause: abortCause,
    });

    expect(classifyDistillBatchFailureKind(wrapped)).toBe("timeout");
  });

  it("treats direct aborted requests as retryable timeout failures", () => {
    expect(classifyDistillBatchFailureKind(new Error("Request was aborted"))).toBe("timeout");
  });
});

describe("filterSessionFilesByAllowlist (#2174)", () => {
  const files = [
    { path: "/home/u/.openclaw/agents/main/sessions/sess-a.jsonl" },
    { path: "/home/u/.openclaw/agents/main/sessions/sess-b.jsonl" },
    { path: "/home/u/.openclaw/agents/main/sessions/other.jsonl" },
  ];

  it("passes through when allowlist is undefined", () => {
    expect(filterSessionFilesByAllowlist(files, undefined)).toEqual(files);
  });

  it("returns empty when allowlist is empty (fail closed)", () => {
    expect(filterSessionFilesByAllowlist(files, [])).toEqual([]);
  });

  it("keeps only matching session stems", () => {
    expect(filterSessionFilesByAllowlist(files, ["sess-a", "sess-b"]).map((f) => f.path)).toEqual([
      files[0].path,
      files[1].path,
    ]);
  });
});
