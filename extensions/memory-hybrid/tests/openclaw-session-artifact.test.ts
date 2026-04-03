// @ts-nocheck
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOpenClawSessionJsonlForKey, looksLikeOpenClawSessionRef } from "../services/openclaw-session-artifact.js";

describe("looksLikeOpenClawSessionRef", () => {
  it("accepts agent:-prefixed keys", () => {
    expect(looksLikeOpenClawSessionRef("agent:forge:subagent:abc")).toBe(true);
  });

  it("accepts bare UUIDs", () => {
    expect(looksLikeOpenClawSessionRef("f3d14066-09ea-492f-a3f3-7ae2fe6c9b0a")).toBe(true);
  });

  it("rejects free-text labels", () => {
    expect(looksLikeOpenClawSessionRef("my-worker")).toBe(false);
    expect(looksLikeOpenClawSessionRef("")).toBe(false);
  });
});

describe("findOpenClawSessionJsonlForKey", () => {
  let tmpDir: string;
  let openclawHome: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "oc-sess-"));
    openclawHome = join(tmpDir, ".openclaw");
    await mkdir(join(openclawHome, "agents", "forge", "sessions"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("finds session file by colon-sanitized basename (portable filenames)", async () => {
    const key = "agent:forge:subagent:f3d14066-09ea-492f-a3f3-7ae2fe6c9b0a";
    const sanitized = key.replace(/:/g, "_");
    const path = join(openclawHome, "agents", "forge", "sessions", `${sanitized}.jsonl`);
    await writeFile(path, "{}\n", "utf-8");
    const found = await findOpenClawSessionJsonlForKey(key, openclawHome);
    expect(found).toBe(path);
  });

  it("finds session file by UUID basename", async () => {
    const uuid = "f3d14066-09ea-492f-a3f3-7ae2fe6c9b0a";
    const key = `agent:forge:subagent:${uuid}`;
    const path = join(openclawHome, "agents", "forge", "sessions", `${uuid}.jsonl`);
    await writeFile(path, "{}\n", "utf-8");
    const found = await findOpenClawSessionJsonlForKey(key, openclawHome);
    expect(found).toBe(path);
  });
});
