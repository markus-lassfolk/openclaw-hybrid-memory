import { getEnv } from "../utils/env-manager.js";
/**
 * Sensor Sweep — cron-based data collection writing to the Event Bus.
 * NO LLM calls at sweep time — structured data only.
 *
 * Tier 1 (every 4h): Garmin, SessionHistory, MemoryPatterns, GitHub
 * Tier 2 (same schedule, anomaly-gated): HomeAssistant, SystemHealth, Weather, Yarbo
 *
 * Issue #236
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type EventBus, computeFingerprint } from "../backends/event-bus.js";
import type { FactsDB } from "../backends/facts-db.js";
import type {
  GarminSensorConfig,
  GitHubSensorConfig,
  HomeAssistantAnomalySensorConfig,
  HomeAssistantSensorConfig,
  MemoryPatternsSensorConfig,
  SensorSweepConfig,
  SessionHistorySensorConfig,
  SystemHealthSensorConfig,
  WeatherSensorConfig,
  YarboSensorConfig,
} from "../config/types/sensors.js";
import { execFile } from "../utils/process-runner.js";
import { stableStringify } from "../utils/stable-stringify.js";
import { capturePluginError } from "./error-reporter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SensorSweepResult {
  sensor: string;
  eventsWritten: number;
  eventsSkipped: number;
  error?: string;
}

interface SweepAllResult {
  sensors: SensorSweepResult[];
  totalWritten: number;
  totalSkipped: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// HA REST helpers
// ---------------------------------------------------------------------------

interface HAEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_updated: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getHAEntityValidationError(value: unknown): string | null {
  if (!isPlainObject(value)) return "value is not an object";
  if (typeof value.entity_id !== "string") return "entity_id is not a string";
  if (typeof value.state !== "string") return "state is not a string";
  if (!isPlainObject(value.attributes)) return "attributes is not an object";
  if (typeof value.last_updated !== "string") return "last_updated is not a string";
  return null;
}

async function parseJsonBody(res: Response, context: string): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON response from ${context}: ${details}`);
  }
}

function parseHAEntities(payload: unknown, context: string): HAEntity[] {
  if (!Array.isArray(payload)) {
    throw new Error(`Invalid Home Assistant response from ${context}: expected array`);
  }
  const valid: HAEntity[] = [];
  for (const [index, item] of payload.entries()) {
    const validationError = getHAEntityValidationError(item);
    if (validationError) {
      capturePluginError(
        new Error(`Invalid Home Assistant entity at index ${index} from ${context}: ${validationError}`),
        { operation: "parse-ha-entities", severity: "info", subsystem: "sensor-sweep" },
      );
      continue;
    }
    valid.push(item as HAEntity);
  }
  return valid;
}

function parseHAEntity(payload: unknown, context: string): HAEntity {
  const validationError = getHAEntityValidationError(payload);
  if (validationError) {
    throw new Error(`Invalid Home Assistant response from ${context}: ${validationError}`);
  }
  return payload as HAEntity;
}

async function fetchHa(ha: HomeAssistantSensorConfig, path: string): Promise<Response> {
  const url = `${ha.baseUrl.replace(/\/$/, "")}${path}`;
  const token = ha.token.startsWith("env:") ? (getEnv(ha.token.slice(4)) ?? "") : ha.token;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ha.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchHaEntities(
  ha: HomeAssistantSensorConfig,
  prefix: string,
  cachedStates?: HAEntity[],
): Promise<HAEntity[]> {
  // If cached states are provided, filter and return from cache
  if (cachedStates) {
    return cachedStates.filter((e) => e.entity_id.startsWith(prefix));
  }

  const res = await fetchHa(ha, "/api/states");
  if (!res.ok) throw new Error(`HA API error: ${res.status} ${res.statusText}`);
  const all = parseHAEntities(await parseJsonBody(res, "HA /api/states"), "HA /api/states");
  return all.filter((e) => e.entity_id.startsWith(prefix));
}

async function fetchHaEntityById(ha: HomeAssistantSensorConfig, entityId: string): Promise<HAEntity | null> {
  const res = await fetchHa(ha, `/api/states/${encodeURIComponent(entityId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HA API error: ${res.status} ${res.statusText}`);
  return parseHAEntity(
    await parseJsonBody(res, `HA /api/states/${encodeURIComponent(entityId)}`),
    `HA /api/states/${encodeURIComponent(entityId)}`,
  );
}

async function fetchAllHaStates(ha: HomeAssistantSensorConfig): Promise<HAEntity[]> {
  const res = await fetchHa(ha, "/api/states");
  if (!res.ok) throw new Error(`HA API error: ${res.status} ${res.statusText}`);
  return parseHAEntities(await parseJsonBody(res, "HA /api/states"), "HA /api/states");
}

// ---------------------------------------------------------------------------
// Tier 1: Garmin Connect via Home Assistant
// ---------------------------------------------------------------------------

async function sweepGarmin(
  bus: EventBus,
  cfg: GarminSensorConfig,
  ha: HomeAssistantSensorConfig,
  cooldownHours: number,
  cachedHaStates?: HAEntity[],
): Promise<SensorSweepResult> {
  const result: SensorSweepResult = { sensor: "garmin", eventsWritten: 0, eventsSkipped: 0 };
  try {
    const prefix = cfg.entityPrefix ?? "sensor.garmin";
    const entities = await fetchHaEntities(ha, prefix, cachedHaStates);
    if (entities.length === 0) return result;

    const payload: Record<string, unknown> = {};
    for (const entity of entities) {
      payload[entity.entity_id] = {
        state: entity.state,
        unit: entity.attributes.unit_of_measurement ?? null,
        last_updated: entity.last_updated,
      };
    }

    const fingerprintPayload: Record<string, unknown> = {};
    for (const entity of entities) {
      fingerprintPayload[entity.entity_id] = {
        state: entity.state,
        unit: entity.attributes.unit_of_measurement ?? null,
      };
    }

    const fp = computeFingerprint(`sensor.garmin:${prefix}:${stableStringify(fingerprintPayload)}`);
    if (bus.dedup(fp, cooldownHours)) {
      result.eventsSkipped++;
      return result;
    }
    bus.appendEvent("sensor.garmin", "garmin-sensor", payload, cfg.importance ?? 0.6, fp);
    result.eventsWritten++;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "sweep-garmin",
      severity: "warning",
      subsystem: "sensor-sweep",
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tier 1: Session History
// ---------------------------------------------------------------------------

interface SessionSummary {
  sessionId: string;
  startTime: string | null;
  messageCount: number;
  topics: string[];
}

function getSessionDir(): string {
  return getEnv("OPENCLAW_SESSION_DIR") ?? join(homedir(), ".openclaw", "sessions");
}

function extractTopicsFromSession(content: string): string[] {
  const topics = new Set<string>();
  try {
    const lines = content.split("\n").filter((l) => l.trim().startsWith("{"));
    for (const line of lines.slice(0, 50)) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const msg = (entry.message ?? entry.content ?? entry.text ?? "") as string;
        if (typeof msg === "string" && msg.length > 10) {
          // Extract noun-phrase-ish tokens (3+ char words, not stopwords)
          const words = msg
            .replace(/[^\w\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length >= 4)
            .slice(0, 5);
          for (const w of words) topics.add(w.toLowerCase());
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // skip
  }
  return [...topics].slice(0, 20);
}

function readRecentSessions(limit: number): SessionSummary[] {
  const sessionDir = getSessionDir();
  if (!existsSync(sessionDir)) return [];
  try {
    const files = readdirSync(sessionDir)
      .filter((f) => f.endsWith(".jsonl") || f.endsWith(".json"))
      .map((f) => ({ name: f, mtime: statSync(join(sessionDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map((f) => f.name);

    return files.map((f) => {
      const path = join(sessionDir, f);
      try {
        const content = readFileSync(path, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim().startsWith("{"));
        let startTime: string | null = null;
        try {
          const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
          const ts = first.timestamp ?? first.created_at ?? first.time;
          if (typeof ts === "string") startTime = ts;
        } catch {
          // skip
        }
        return {
          sessionId: f.replace(/\.(jsonl|json)$/, ""),
          startTime,
          messageCount: lines.length,
          topics: extractTopicsFromSession(content),
        };
      } catch {
        return { sessionId: f, startTime: null, messageCount: 0, topics: [] };
      }
    });
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "read-session-dir",
      severity: "info",
      subsystem: "sensor-sweep",
    });
    return [];
  }
}

export async function sweepSessionHistory(
  bus: EventBus,
  cfg: SessionHistorySensorConfig,
  cooldownHours: number,
): Promise<SensorSweepResult> {
  const result: SensorSweepResult = { sensor: "session-history", eventsWritten: 0, eventsSkipped: 0 };
  try {
    const limit = cfg.recentSessions ?? 10;
    const sessions = readRecentSessions(limit);
    if (sessions.length === 0) return result;

    const payload = {
      sessionCount: sessions.length,
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        startTime: s.startTime,
        messageCount: s.messageCount,
        topTopics: s.topics.slice(0, 10),
      })),
    };

    const fp = computeFingerprint(`sensor.session-history:${limit}:${stableStringify(payload)}`);
    if (bus.dedup(fp, cooldownHours)) {
      result.eventsSkipped++;
      return result;
    }

    bus.appendEvent("sensor.session-history", "session-history-sensor", payload, cfg.importance ?? 0.5, fp);
    result.eventsWritten++;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "sweep-session-history",
      severity: "warning",
      subsystem: "sensor-sweep",
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tier 1: Memory Patterns
// ---------------------------------------------------------------------------

export async function sweepMemoryPatterns(
  bus: EventBus,
  cfg: MemoryPatternsSensorConfig,
  factsDb: FactsDB,
  cooldownHours: number,
): Promise<SensorSweepResult> {
  const result: SensorSweepResult = { sensor: "memory-patterns", eventsWritten: 0, eventsSkipped: 0 };
  try {
    const hotThreshold = cfg.hotAccessThreshold ?? 3;
    const staleAfterDays = cfg.staleAfterDays ?? 14;
    const staleCutoffSec = Math.floor((Date.now() - staleAfterDays * 24 * 3600 * 1000) / 1000);

    const totalFacts = factsDb.getCount();
    const categoryBreakdown = factsDb.statsBreakdownByCategory();

    // Sample up to 500 facts to identify hot/stale/open-loop patterns
    const sample = factsDb.getBatch(0, 500);

    const hotFacts = sample.filter((f) => (f.recallCount ?? 0) >= hotThreshold);
    const staleFacts = sample.filter(
      (f) =>
        f.supersededAt == null &&
        f.lastAccessed !== null &&
        f.lastAccessed !== undefined &&
        (f.lastAccessed as number) < staleCutoffSec,
    );
    const openLoops = sample.filter((f) => (f.category === "goal" || f.category === "task") && f.supersededAt == null);

    const payload = {
      totalFacts,
      hotFactCount: hotFacts.length,
      staleFactCount: staleFacts.length,
      openLoopCount: openLoops.length,
      categoryBreakdown,
      hotFactIds: hotFacts.slice(0, 10).map((f) => f.id),
      staleFactIds: staleFacts.slice(0, 10).map((f) => f.id),
      openLoopIds: openLoops.slice(0, 10).map((f) => f.id),
    };

    const fp = computeFingerprint(`sensor.memory-patterns:${stableStringify(payload)}`);
    if (bus.dedup(fp, cooldownHours)) {
      result.eventsSkipped++;
      return result;
    }

    bus.appendEvent("sensor.memory-patterns", "memory-patterns-sensor", payload, cfg.importance ?? 0.4, fp);
    result.eventsWritten++;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "sweep-memory-patterns",
      severity: "warning",
      subsystem: "sensor-sweep",
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tier 1: GitHub
// ---------------------------------------------------------------------------

interface GitHubPR {
  number: number;
  title: string;
  state: string;
  url: string;
  reviewDecision?: string;
  isDraft?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  updatedAt?: string;
}

const execFileAsync = promisify(execFile);

/** Progress callback: reports a short human-readable label immediately before a slow step starts. */
export type SensorSweepProgress = (label: string) => void;

async function tryExecFile(file: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, args, { encoding: "utf-8", timeout: 15_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

function parseGhJson<T>(output: string | null): T[] {
  if (!output) return [];
  try {
    const parsed = JSON.parse(output) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export async function sweepGitHub(
  bus: EventBus,
  cfg: GitHubSensorConfig,
  cooldownHours: number,
  onProgress?: SensorSweepProgress,
): Promise<SensorSweepResult> {
  const result: SensorSweepResult = { sensor: "github", eventsWritten: 0, eventsSkipped: 0 };
  try {
    const repo = cfg.repo ?? "";

    // Check if gh CLI is available
    onProgress?.("github: checking gh CLI availability");
    const ghCheck = await tryExecFile("gh", ["--version"]);
    if (!ghCheck) {
      result.error = "gh CLI not available";
      return result;
    }

    const repoArgs = cfg.repo ? ["--repo", cfg.repo] : [];

    // Open PRs
    onProgress?.("github: listing open PRs");
    const prOutput = await tryExecFile("gh", [
      "pr",
      "list",
      ...repoArgs,
      "--state",
      "open",
      "--limit",
      "20",
      "--json",
      "number,title,state,url,reviewDecision,isDraft,createdAt,updatedAt",
    ]);
    const openPrs = parseGhJson<GitHubPR>(prOutput);

    // Review requests (PRs where we are requested reviewer)
    let reviewRequests: GitHubPR[] = [];
    if (cfg.includeReviewRequests !== false) {
      onProgress?.("github: listing review-requested PRs");
      const rrOutput = await tryExecFile("gh", [
        "pr",
        "list",
        ...repoArgs,
        "--state",
        "open",
        "--review-requested",
        "@me",
        "--limit",
        "20",
        "--json",
        "number,title,state,url,reviewDecision,isDraft,createdAt,updatedAt",
      ]);
      reviewRequests = parseGhJson<GitHubPR>(rrOutput);
    }

    // CI failures on open PRs
    const ciFailures: Array<{ pr: number; title: string; url: string }> = [];
    const prsToCheck = openPrs.slice(0, 5);
    for (const [index, pr] of prsToCheck.entries()) {
      onProgress?.(`github: pr checks (${index + 1}/${prsToCheck.length})`);
      const ciOutput = await tryExecFile("gh", [
        "pr",
        "checks",
        ...repoArgs,
        String(pr.number),
        "--json",
        "name,bucket",
      ]);
      if (ciOutput) {
        try {
          const checks = JSON.parse(ciOutput) as Array<{ name: string; bucket: string }>;
          if (checks.some((c) => c.bucket === "fail")) {
            ciFailures.push({ pr: pr.number, title: pr.title, url: pr.url });
          }
        } catch {
          // skip
        }
      }
    }

    // Stale issues
    const staleIssueDays = cfg.staleIssueDays ?? 7;
    const staleCutoff = new Date(Date.now() - staleIssueDays * 24 * 3600 * 1000).toISOString();
    onProgress?.("github: listing open issues");
    const issueOutput = await tryExecFile("gh", [
      "issue",
      "list",
      ...repoArgs,
      "--state",
      "open",
      "--limit",
      "30",
      "--json",
      "number,title,state,url,updatedAt",
    ]);
    const allIssues = parseGhJson<GitHubIssue>(issueOutput);
    const staleIssues = allIssues.filter((i) => i.updatedAt !== undefined && i.updatedAt < staleCutoff);

    const payload = {
      openPrCount: openPrs.length,
      openPrs: openPrs.slice(0, 10).map((p) => ({
        number: p.number,
        title: p.title,
        url: p.url,
        isDraft: p.isDraft ?? false,
        reviewDecision: p.reviewDecision ?? null,
      })),
      reviewRequestCount: reviewRequests.length,
      reviewRequests: reviewRequests.slice(0, 5).map((p) => ({
        number: p.number,
        title: p.title,
        url: p.url,
      })),
      ciFailureCount: ciFailures.length,
      ciFailures: ciFailures.slice(0, 5),
      staleIssueCount: staleIssues.length,
      staleIssues: staleIssues.slice(0, 5).map((i) => ({
        number: i.number,
        title: i.title,
        url: i.url,
        updatedAt: i.updatedAt ?? null,
      })),
    };

    const fp = computeFingerprint(`sensor.github:${repo}:${stableStringify(payload)}`);
    if (bus.dedup(fp, cooldownHours)) {
      result.eventsSkipped++;
      return result;
    }

    bus.appendEvent("sensor.github", "github-sensor", payload, cfg.importance ?? 0.7, fp);
    result.eventsWritten++;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "sweep-github",
      severity: "warning",
      subsystem: "sensor-sweep",
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tier 2: Home Assistant Anomaly Detection
// ---------------------------------------------------------------------------

async function sweepHomeAssistantAnomaly(
  bus: EventBus,
  cfg: HomeAssistantAnomalySensorConfig,
  ha: HomeAssistantSensorConfig,
  cooldownHours: number,
  onProgress?: SensorSweepProgress,
): Promise<SensorSweepResult> {
  const result: SensorSweepResult = { sensor: "ha-anomaly", eventsWritten: 0, eventsSkipped: 0 };
  try {
    const watchEntities = cfg.watchEntities ?? [];
    if (watchEntities.length === 0) return result;

    const states: Record<string, { state: string; last_updated: string }> = {};
    // Fetch only the specific watched entities by ID to avoid downloading all HA states.
    onProgress?.(`ha-anomaly: fetching ${watchEntities.length} watched entities`);
    // Promise.allSettled (not Promise.all): one flaky/timed-out entity must not suppress
    // the anomaly states already fetched for every other watched entity this cycle.
    const settled = await Promise.allSettled(
      watchEntities.map(async (entityId) => {
        const entity = await fetchHaEntityById(ha, entityId);
        if (entity) {
          states[entityId] = { state: entity.state, last_updated: entity.last_updated };
        }
      }),
    );
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      if (outcome.status === "rejected") {
        capturePluginError(outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason)), {
          operation: "sweep-ha-anomaly:fetch-entity",
          severity: "warning",
          subsystem: "sensor-sweep",
          entityId: watchEntities[i],
        });
      }
    }

    if (Object.keys(states).length === 0) return result;

    // Detect anomalies: unavailable/unknown states or binary_sensor = "on" for unexpected items
    const anomalies: Array<{ entity: string; state: string; reason: string }> = [];
    for (const [entity, info] of Object.entries(states)) {
      if (info.state === "unavailable" || info.state === "unknown") {
        anomalies.push({ entity, state: info.state, reason: "sensor_failure" });
      }
    }

    if (anomalies.length === 0) {
      return result;
    }

    const anomalyKey = anomalies
      .map((a) => `${a.entity}:${a.state}`)
      .sort()
      .join("|");
    const fp = computeFingerprint(`sensor.ha-anomaly:${anomalyKey}`);
    if (bus.dedup(fp, cooldownHours)) {
      result.eventsSkipped++;
      return result;
    }

    bus.appendEvent(
      "sensor.ha-anomaly",
      "ha-anomaly-sensor",
      { anomalies, entityStates: states },
      cfg.importance ?? 0.8,
      fp,
    );
    result.eventsWritten++;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "sweep-ha-anomaly",
      severity: "warning",
      subsystem: "sensor-sweep",
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tier 2: System Health
// ---------------------------------------------------------------------------

export async function sweepSystemHealth(
  bus: EventBus,
  cfg: SystemHealthSensorConfig,
  resolvedSqlitePath: string,
  cooldownHours: number,
): Promise<SensorSweepResult> {
  const result: SensorSweepResult = { sensor: "system-health", eventsWritten: 0, eventsSkipped: 0 };
  try {
    let sqliteSizeBytes: number | null = null;
    try {
      if (existsSync(resolvedSqlitePath)) {
        sqliteSizeBytes = statSync(resolvedSqlitePath).size;
      }
    } catch {
      // ignore
    }

    const uptimeSeconds = process.uptime();
    const memoryUsage = process.memoryUsage();

    const payload = {
      uptimeSeconds: Math.floor(uptimeSeconds),
      memoryRssBytes: memoryUsage.rss,
      memoryHeapUsedBytes: memoryUsage.heapUsed,
      memoryHeapTotalBytes: memoryUsage.heapTotal,
      sqliteSizeBytes,
      nodeVersion: process.version,
      platform: process.platform,
    };

    // System health metrics (uptime, memory) are inherently volatile and change
    // on every invocation. Content-based dedup is not feasible here, so we use
    // a stable time-based key: one event per cooldown window per node/platform.
    const fp = computeFingerprint(`sensor.system-health:${process.version}:${process.platform}`);
    if (bus.dedup(fp, cooldownHours)) {
      result.eventsSkipped++;
      return result;
    }

    bus.appendEvent("sensor.system-health", "system-health-sensor", payload, cfg.importance ?? 0.7, fp);
    result.eventsWritten++;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "sweep-system-health",
      severity: "warning",
      subsystem: "sensor-sweep",
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tier 2: Weather
// ---------------------------------------------------------------------------

async function sweepWeather(
  bus: EventBus,
  cfg: WeatherSensorConfig,
  cooldownHours: number,
  onProgress?: SensorSweepProgress,
): Promise<SensorSweepResult> {
  const result: SensorSweepResult = { sensor: "weather", eventsWritten: 0, eventsSkipped: 0 };
  try {
    const location = cfg.location ?? "auto";

    const url =
      location === "auto" ? "https://wttr.in/?format=j1" : `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let weatherData: Record<string, unknown> = {};
    try {
      onProgress?.("weather: fetching");
      const res = await fetch(url, { signal: controller.signal });
      if (res.ok) {
        const json = (await res.json()) as Record<string, unknown>;
        // Extract just the current condition — avoid large payloads
        const current = (json.current_condition as unknown[])?.[0] as Record<string, unknown> | undefined;
        weatherData = {
          location,
          tempC: current?.temp_C ?? null,
          feelsLikeC: current?.FeelsLikeC ?? null,
          humidity: current?.humidity ?? null,
          weatherDesc: (current?.weatherDesc as Array<{ value?: string }>)?.[0]?.value ?? null,
          windspeedKmph: current?.windspeedKmph ?? null,
          precipMM: current?.precipMM ?? null,
        };
      } else {
        result.error = `wttr.in HTTP ${res.status}`;
        return result;
      }
    } finally {
      clearTimeout(timeout);
    }

    const fp = computeFingerprint(`sensor.weather:${location}:${stableStringify(weatherData)}`);
    if (bus.dedup(fp, cooldownHours)) {
      result.eventsSkipped++;
      return result;
    }

    bus.appendEvent("sensor.weather", "weather-sensor", weatherData, cfg.importance ?? 0.3, fp);
    result.eventsWritten++;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "sweep-weather",
      severity: "info",
      subsystem: "sensor-sweep",
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tier 2: Yarbo
// ---------------------------------------------------------------------------

async function sweepYarbo(
  bus: EventBus,
  cfg: YarboSensorConfig,
  ha: HomeAssistantSensorConfig,
  cooldownHours: number,
  cachedHaStates?: HAEntity[],
): Promise<SensorSweepResult> {
  const result: SensorSweepResult = { sensor: "yarbo", eventsWritten: 0, eventsSkipped: 0 };
  try {
    const prefix = cfg.entityPrefix ?? "sensor.yarbo";

    const entities = await fetchHaEntities(ha, prefix, cachedHaStates);
    if (entities.length === 0) return result;

    const errorEntities = entities.filter(
      (e) =>
        e.state === "error" ||
        e.state === "unavailable" ||
        e.state === "unknown" ||
        String(e.attributes.error_count ?? 0) !== "0",
    );

    // Only write if there's something notable
    if (errorEntities.length === 0 && entities.every((e) => e.state === "idle" || e.state === "off")) {
      return result;
    }

    const payload: Record<string, unknown> = {};
    for (const entity of entities) {
      payload[entity.entity_id] = {
        state: entity.state,
        attributes: entity.attributes,
        last_updated: entity.last_updated,
      };
    }

    const fingerprintPayload: Record<string, unknown> = {};
    for (const entity of entities) {
      fingerprintPayload[entity.entity_id] = {
        state: entity.state,
        error_count: entity.attributes.error_count ?? 0,
      };
    }

    const fp = computeFingerprint(`sensor.yarbo:${prefix}:${stableStringify(fingerprintPayload)}`);
    if (bus.dedup(fp, cooldownHours)) {
      result.eventsSkipped++;
      return result;
    }

    bus.appendEvent(
      "sensor.yarbo",
      "yarbo-sensor",
      { entities: payload, errorCount: errorEntities.length },
      cfg.importance ?? 0.6,
      fp,
    );
    result.eventsWritten++;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "sweep-yarbo",
      severity: "warning",
      subsystem: "sensor-sweep",
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main sweep runner
// ---------------------------------------------------------------------------

interface SweepAllOpts {
  tier?: 1 | 2 | "all";
  sources?: string[];
  dryRun?: boolean;
  resolvedSqlitePath?: string;
  /**
   * Called with a short label immediately before each sensor (and, for multi-step sensors
   * like GitHub, before each individual `gh`/network call) starts. Lets a verbose CLI caller
   * emit progress so a cron log doesn't look hung during slow sequential `gh` CLI calls or
   * network-bound sensors. No-op if omitted; never affects sweep behavior.
   */
  onProgress?: SensorSweepProgress;
}

export async function sweepAll(
  bus: EventBus,
  cfg: SensorSweepConfig,
  factsDb: FactsDB,
  opts: SweepAllOpts = {},
): Promise<SweepAllResult> {
  const cooldown = cfg.dedupCooldownHours ?? 4;
  const tier = opts.tier ?? 1;
  const sources = opts.sources ?? null;

  const results: SensorSweepResult[] = [];

  // Map config-style camelCase names to internal hyphenated names
  const nameMap: Record<string, string> = {
    homeAssistantAnomaly: "ha-anomaly",
    sessionHistory: "session-history",
    memoryPatterns: "memory-patterns",
    systemHealth: "system-health",
  };

  // Normalize sources to internal names
  const normalizedSources = sources?.map((s) => nameMap[s] ?? s) ?? null;

  function shouldRun(name: string): boolean {
    if (normalizedSources !== null && !normalizedSources.includes(name)) return false;
    return true;
  }

  const ha = cfg.homeAssistant;

  // Fetch all HA states once if any HA-dependent sensors will run (Garmin or Yarbo).
  // This avoids duplicate full-state fetches within a single sweep run.
  let cachedHaStates: HAEntity[] | undefined;
  if (ha && !opts.dryRun) {
    const needsHaStates =
      ((tier === 1 || tier === "all") && shouldRun("garmin") && cfg.garmin?.enabled) ||
      ((tier === 2 || tier === "all") && shouldRun("yarbo") && cfg.yarbo?.enabled);
    if (needsHaStates) {
      try {
        opts.onProgress?.("home-assistant: fetching all states");
        cachedHaStates = await fetchAllHaStates(ha);
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "sweep-all-fetch-ha-states",
          severity: "warning",
          subsystem: "sensor-sweep",
        });
      }
    }
  }

  const onProgress = opts.onProgress;

  // Tier 1
  if (tier === 1 || tier === "all") {
    if (shouldRun("garmin") && cfg.garmin?.enabled && ha) {
      if (!opts.dryRun) {
        onProgress?.("garmin");
        results.push(await sweepGarmin(bus, cfg.garmin, ha, cooldown, cachedHaStates));
      } else {
        results.push({ sensor: "garmin", eventsWritten: 0, eventsSkipped: 0 });
      }
    }

    if (shouldRun("session-history") && cfg.sessionHistory?.enabled) {
      if (!opts.dryRun) {
        onProgress?.("session-history");
        results.push(await sweepSessionHistory(bus, cfg.sessionHistory, cooldown));
      } else {
        results.push({ sensor: "session-history", eventsWritten: 0, eventsSkipped: 0 });
      }
    }

    if (shouldRun("memory-patterns") && cfg.memoryPatterns?.enabled) {
      if (!opts.dryRun) {
        onProgress?.("memory-patterns");
        results.push(await sweepMemoryPatterns(bus, cfg.memoryPatterns, factsDb, cooldown));
      } else {
        results.push({ sensor: "memory-patterns", eventsWritten: 0, eventsSkipped: 0 });
      }
    }

    if (shouldRun("github") && cfg.github?.enabled) {
      if (!opts.dryRun) {
        onProgress?.("github");
        results.push(await sweepGitHub(bus, cfg.github, cooldown, onProgress));
      } else {
        results.push({ sensor: "github", eventsWritten: 0, eventsSkipped: 0 });
      }
    }
  }

  // Tier 2
  if (tier === 2 || tier === "all") {
    if (shouldRun("ha-anomaly") && cfg.homeAssistantAnomaly?.enabled && ha) {
      if (!opts.dryRun) {
        onProgress?.("ha-anomaly");
        results.push(await sweepHomeAssistantAnomaly(bus, cfg.homeAssistantAnomaly, ha, cooldown, onProgress));
      } else {
        results.push({ sensor: "ha-anomaly", eventsWritten: 0, eventsSkipped: 0 });
      }
    }

    if (shouldRun("system-health") && cfg.systemHealth?.enabled) {
      if (!opts.dryRun) {
        onProgress?.("system-health");
        results.push(await sweepSystemHealth(bus, cfg.systemHealth, opts.resolvedSqlitePath ?? "", cooldown));
      } else {
        results.push({ sensor: "system-health", eventsWritten: 0, eventsSkipped: 0 });
      }
    }

    if (shouldRun("weather") && cfg.weather?.enabled) {
      if (!opts.dryRun) {
        onProgress?.("weather");
        results.push(await sweepWeather(bus, cfg.weather, cooldown, onProgress));
      } else {
        results.push({ sensor: "weather", eventsWritten: 0, eventsSkipped: 0 });
      }
    }

    if (shouldRun("yarbo") && cfg.yarbo?.enabled && ha) {
      if (!opts.dryRun) {
        onProgress?.("yarbo");
        results.push(await sweepYarbo(bus, cfg.yarbo, ha, cooldown, cachedHaStates));
      } else {
        results.push({ sensor: "yarbo", eventsWritten: 0, eventsSkipped: 0 });
      }
    }
  }

  const totalWritten = results.reduce((s, r) => s + r.eventsWritten, 0);
  const totalSkipped = results.reduce((s, r) => s + r.eventsSkipped, 0);
  const errors = results.filter((r) => r.error).map((r) => `${r.sensor}: ${r.error}`);

  return { sensors: results, totalWritten, totalSkipped, errors };
}
