import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import {
  type VersionCheckCacheEntry,
  fetchLatestPublishedVersion,
  isPluginOutdated,
  isVersionCheckCacheFresh,
  markUpdateNudged,
  maybeLogOutdatedVersionNudge,
  readVersionCheckCache,
  shouldEmitUpdateNudge,
  writeVersionCheckCache,
} from "../utils/plugin-update-check.js";

describe("plugin update check config", () => {
  const baseConfig = {
    embedding: {
      provider: "openai" as const,
      model: "text-embedding-3-small",
      apiKey: "sk-test-key-that-is-long-enough",
    },
    lanceDbPath: "/tmp/test-lance",
    sqlitePath: "/tmp/test.db",
  };

  it("defaults updateNudge to enabled with 24h interval and cache TTL", () => {
    const cfg = hybridConfigSchema.parse(baseConfig);
    expect(cfg.errorReporting.updateNudge).toEqual({
      enabled: true,
      intervalHours: 24,
      cacheTtlHours: 24,
    });
  });

  it("accepts custom updateNudge overrides", () => {
    const cfg = hybridConfigSchema.parse({
      ...baseConfig,
      errorReporting: {
        enabled: true,
        consent: true,
        updateNudge: {
          enabled: false,
          intervalHours: 6,
          cacheTtlHours: 12,
        },
      },
    });
    expect(cfg.errorReporting.updateNudge).toEqual({
      enabled: false,
      intervalHours: 6,
      cacheTtlHours: 12,
    });
  });
});

describe("plugin update check utilities", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "plugin-update-check-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("prefers the newest published version across npm and GitHub", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (new URL(url).hostname === "registry.npmjs.org") {
        return new Response(JSON.stringify({ version: "2026.3.180" }), { status: 200 });
      }
      return new Response(JSON.stringify({ tag_name: "v2026.3.190" }), { status: 200 });
    });

    await expect(fetchLatestPublishedVersion(fetchMock as typeof fetch)).resolves.toEqual({
      latestVersion: "2026.3.190",
      source: "github",
    });
  });

  it("falls back cleanly when one upstream is unavailable", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (new URL(url).hostname === "registry.npmjs.org") {
        throw new Error("network down");
      }
      return new Response(JSON.stringify({ tag_name: "v2026.3.188" }), { status: 200 });
    });

    await expect(fetchLatestPublishedVersion(fetchMock as typeof fetch)).resolves.toEqual({
      latestVersion: "2026.3.188",
      source: "github",
    });
  });

  it("reads and writes version-check cache entries", () => {
    const cachePath = join(tempDir, ".latest-plugin-version.json");
    const entry: VersionCheckCacheEntry = {
      latestVersion: "2026.3.190",
      source: "npm",
      checkedAt: "2026-03-24T10:00:00.000Z",
      lastNudgedAt: "2026-03-24T10:00:00.000Z",
    };

    writeVersionCheckCache(cachePath, entry);
    expect(readVersionCheckCache(cachePath)).toEqual(entry);
  });

  it("respects staleness and nudge intervals", () => {
    const entry: VersionCheckCacheEntry = {
      latestVersion: "2026.3.190",
      source: "npm",
      checkedAt: "2026-03-24T00:00:00.000Z",
      lastNudgedAt: "2026-03-24T00:00:00.000Z",
    };
    const nudge = { enabled: true, intervalHours: 24, cacheTtlHours: 24 };
    const nowMs = Date.parse("2026-03-24T12:00:00.000Z");

    expect(isVersionCheckCacheFresh(entry, nudge.cacheTtlHours, nowMs)).toBe(true);
    expect(shouldEmitUpdateNudge(entry, nudge, nowMs)).toBe(false);
    expect(isPluginOutdated("2026.3.181", entry.latestVersion)).toBe(true);
  });

  it("logs a warning and stamps lastNudgedAt when an outdated install is due for a nudge", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const entry: VersionCheckCacheEntry = {
      latestVersion: "2026.3.190",
      source: "npm",
      checkedAt: "2026-03-24T00:00:00.000Z",
    };

    const updated = maybeLogOutdatedVersionNudge(
      "2026.3.181",
      entry,
      { enabled: true, intervalHours: 24, cacheTtlHours: 24 },
      logger,
    );

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Telemetry is muted on outdated clients"));
    expect(updated.lastNudgedAt).toBeDefined();
    expect(markUpdateNudged(entry, "2026-03-24T11:00:00.000Z").lastNudgedAt).toBe("2026-03-24T11:00:00.000Z");
  });
});
