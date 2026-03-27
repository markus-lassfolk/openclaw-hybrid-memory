import { dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { UpdateNudgeConfig } from "../config.js";
import { compareVersions } from "./version-check.js";

const DEFAULT_TIMEOUT_MS = 3000;
const NPM_LATEST_URL = "https://registry.npmjs.org/openclaw-hybrid-memory/latest";
const GITHUB_LATEST_URL = "https://api.github.com/repos/markus-lassfolk/openclaw-hybrid-memory/releases/latest";

export interface LatestPublishedVersion {
  latestVersion: string | null;
  source: "npm" | "github" | null;
}

export interface VersionCheckCacheEntry {
  latestVersion: string;
  source: "npm" | "github";
  checkedAt: string;
  lastNudgedAt?: string;
}

export interface UpdateNudgeLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
}

async function fetchWithTimeout(
  url: string,
  expectedHostname: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.hostname !== expectedHostname) {
    throw new Error(`Unexpected hostname: ${parsed.hostname}`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function asVersionString(value: unknown): string | null {
  return typeof value === "string" && /^v?\d+\.\d+\.\d+/.test(value.trim()) ? value.trim().replace(/^v/, "") : null;
}

export async function fetchLatestPublishedVersion(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<LatestPublishedVersion> {
  const candidates: Array<{ version: string; source: "npm" | "github" }> = [];

  try {
    const response = await fetchWithTimeout(NPM_LATEST_URL, "registry.npmjs.org", timeoutMs, fetchImpl);
    if (response.ok) {
      const payload = (await response.json()) as { version?: unknown };
      const version = asVersionString(payload.version);
      if (version) candidates.push({ version, source: "npm" });
    }
  } catch {
    /* non-fatal */
  }

  try {
    const response = await fetchWithTimeout(GITHUB_LATEST_URL, "api.github.com", timeoutMs, fetchImpl);
    if (response.ok) {
      const payload = (await response.json()) as { tag_name?: unknown };
      const version = asVersionString(payload.tag_name);
      if (version) candidates.push({ version, source: "github" });
    }
  } catch {
    /* non-fatal */
  }

  const newest = candidates.reduce<{ version: string; source: "npm" | "github" } | null>((latest, candidate) => {
    if (!latest) return candidate;
    return compareVersions(candidate.version, latest.version) > 0 ? candidate : latest;
  }, null);

  return {
    latestVersion: newest?.version ?? null,
    source: newest?.source ?? null,
  };
}

export function isPluginOutdated(currentVersion: string, latestVersion: string | null): boolean {
  return latestVersion != null && compareVersions(currentVersion, latestVersion) < 0;
}

export function readVersionCheckCache(cacheFilePath: string): VersionCheckCacheEntry | null {
  try {
    const raw = JSON.parse(readFileSync(cacheFilePath, "utf-8")) as Partial<VersionCheckCacheEntry>;
    if (
      typeof raw.latestVersion !== "string" ||
      (raw.source !== "npm" && raw.source !== "github") ||
      typeof raw.checkedAt !== "string"
    ) {
      return null;
    }
    return {
      latestVersion: raw.latestVersion,
      source: raw.source,
      checkedAt: raw.checkedAt,
      lastNudgedAt: typeof raw.lastNudgedAt === "string" ? raw.lastNudgedAt : undefined,
    };
  } catch {
    return null;
  }
}

export function writeVersionCheckCache(cacheFilePath: string, entry: VersionCheckCacheEntry): void {
  mkdirSync(dirname(cacheFilePath), { recursive: true });
  writeFileSync(cacheFilePath, JSON.stringify(entry, null, 2), "utf-8");
}

export function isVersionCheckCacheFresh(
  entry: VersionCheckCacheEntry,
  cacheTtlHours: number,
  nowMs = Date.now(),
): boolean {
  const checkedAtMs = Date.parse(entry.checkedAt);
  if (!Number.isFinite(checkedAtMs)) return false;
  return nowMs - checkedAtMs <= cacheTtlHours * 3600_000;
}

export function shouldEmitUpdateNudge(
  entry: VersionCheckCacheEntry,
  updateNudge: UpdateNudgeConfig,
  nowMs = Date.now(),
): boolean {
  if (!updateNudge.enabled) return false;
  if (updateNudge.intervalHours === 0) return false;
  if (!entry.lastNudgedAt) return true;
  const lastNudgedMs = Date.parse(entry.lastNudgedAt);
  if (!Number.isFinite(lastNudgedMs)) return true;
  return nowMs - lastNudgedMs >= updateNudge.intervalHours * 3600_000;
}

export function markUpdateNudged(
  entry: VersionCheckCacheEntry,
  nowIso = new Date().toISOString(),
): VersionCheckCacheEntry {
  return { ...entry, lastNudgedAt: nowIso };
}

export function maybeLogOutdatedVersionNudge(
  currentVersion: string,
  entry: VersionCheckCacheEntry,
  updateNudge: UpdateNudgeConfig,
  logger: UpdateNudgeLogger,
): VersionCheckCacheEntry {
  if (!isPluginOutdated(currentVersion, entry.latestVersion)) return entry;
  if (!updateNudge.enabled) {
    logger.info?.(
      `memory-hybrid: telemetry muted for outdated plugin v${currentVersion} (latest published: v${entry.latestVersion}).`,
    );
    return entry;
  }
  if (!shouldEmitUpdateNudge(entry, updateNudge)) {
    logger.info?.(
      `memory-hybrid: telemetry muted for outdated plugin v${currentVersion} (latest published: v${entry.latestVersion}).`,
    );
    return entry;
  }

  logger.warn?.(
    `memory-hybrid: update available — installed v${currentVersion}, latest published is v${entry.latestVersion}. Telemetry is muted on outdated clients to keep GlitchTip clean. Upgrade with: openclaw hybrid-mem upgrade`,
  );
  return markUpdateNudged(entry);
}
