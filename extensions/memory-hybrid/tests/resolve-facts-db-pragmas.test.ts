import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveFactsDbPragmas } from "../backends/facts-db/resolve-facts-db-pragmas.js";
import { getEnv, setEnv } from "../utils/env-manager.js";

describe("resolveFactsDbPragmas", () => {
  let tmp: string;
  const prevCache = getEnv("OPENCLAW_FACTS_CACHE_SIZE_KB");
  const prevMmap = getEnv("OPENCLAW_FACTS_MMAP_SIZE");

  beforeEach(() => {
    // Host-level production sizing overrides must not affect default assertions.
    setEnv("OPENCLAW_FACTS_CACHE_SIZE_KB", undefined);
    setEnv("OPENCLAW_FACTS_MMAP_SIZE", undefined);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    setEnv("OPENCLAW_FACTS_CACHE_SIZE_KB", prevCache);
    setEnv("OPENCLAW_FACTS_MMAP_SIZE", prevMmap);
  });

  it("returns defaults when db file is missing", () => {
    tmp = mkdtempSync(join(tmpdir(), "facts-pragmas-"));
    const p = resolveFactsDbPragmas(join(tmp, "missing.db"));
    expect(p.cacheSizeKb).toBe(64_000);
    expect(p.mmapSizeBytes).toBe(268_435_456);
  });

  it("clamps oversized env to db file size", () => {
    tmp = mkdtempSync(join(tmpdir(), "facts-pragmas-"));
    const dbPath = join(tmp, "facts.db");
    writeFileSync(dbPath, Buffer.alloc(10 * 1024 * 1024)); // 10MB
    setEnv("OPENCLAW_FACTS_CACHE_SIZE_KB", "524288"); // 512MB request
    setEnv("OPENCLAW_FACTS_MMAP_SIZE", String(2 * 1024 * 1024 * 1024)); // 2GB
    const p = resolveFactsDbPragmas(dbPath);
    expect(p.cacheSizeKb).toBeLessThanOrEqual(Math.ceil(((10 * 1024 * 1024) / 1024) * 1.5));
    expect(p.mmapSizeBytes).toBeLessThanOrEqual(10 * 1024 * 1024 + 64 * 1024 * 1024);
  });
});
