import type {
  SensorSweepConfig,
  HomeAssistantSensorConfig,
  GarminSensorConfig,
  SessionHistorySensorConfig,
  MemoryPatternsSensorConfig,
  GitHubSensorConfig,
  HomeAssistantAnomalySensorConfig,
  SystemHealthSensorConfig,
  WeatherSensorConfig,
  YarboSensorConfig,
} from "../types/sensors.js";

function parseSourceEnabled(raw: Record<string, unknown> | undefined, master: boolean): boolean {
  if (!master) return false;
  return raw?.enabled !== false;
}

function parseImportance(raw: Record<string, unknown> | undefined): number | undefined {
  const v = raw?.importance;
  if (typeof v === "number" && v >= 0 && v <= 1) return v;
  return undefined;
}

function parseHaConfig(raw: Record<string, unknown> | undefined): HomeAssistantSensorConfig | undefined {
  if (!raw) return undefined;
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
  const token = typeof raw.token === "string" ? raw.token.trim() : "";
  if (!baseUrl || !token) return undefined;
  const timeoutMs =
    typeof raw.timeoutMs === "number" && raw.timeoutMs > 0
      ? Math.floor(raw.timeoutMs)
      : 10_000;
  return { baseUrl, token, timeoutMs };
}

export function parseSensorSweepConfig(cfg: Record<string, unknown>): SensorSweepConfig {
  const raw = cfg.sensorSweep as Record<string, unknown> | undefined;
  const enabled = raw?.enabled === true;

  if (!enabled) {
    return { enabled: false };
  }

  const schedule =
    typeof raw?.schedule === "string" && raw.schedule.trim().length > 0
      ? raw.schedule.trim()
      : "0 */4 * * *";

  const dedupCooldownHours =
    typeof raw?.dedupCooldownHours === "number" && raw.dedupCooldownHours > 0
      ? raw.dedupCooldownHours
      : 3;

  const haRaw = raw?.homeAssistant as Record<string, unknown> | undefined;
  const homeAssistant = parseHaConfig(haRaw);

  const garminRaw = raw?.garmin as Record<string, unknown> | undefined;
  const garmin: GarminSensorConfig = {
    enabled: parseSourceEnabled(garminRaw, enabled),
    importance: parseImportance(garminRaw) ?? 0.6,
    entityPrefix:
      typeof garminRaw?.entityPrefix === "string" && garminRaw.entityPrefix.trim().length > 0
        ? garminRaw.entityPrefix.trim()
        : "sensor.garmin",
  };

  const sessionHistoryRaw = raw?.sessionHistory as Record<string, unknown> | undefined;
  const sessionHistory: SessionHistorySensorConfig = {
    enabled: parseSourceEnabled(sessionHistoryRaw, enabled),
    importance: parseImportance(sessionHistoryRaw) ?? 0.5,
    recentSessions:
      typeof sessionHistoryRaw?.recentSessions === "number" && sessionHistoryRaw.recentSessions >= 1
        ? Math.floor(sessionHistoryRaw.recentSessions)
        : 10,
  };

  const memoryPatternsRaw = raw?.memoryPatterns as Record<string, unknown> | undefined;
  const memoryPatterns: MemoryPatternsSensorConfig = {
    enabled: parseSourceEnabled(memoryPatternsRaw, enabled),
    importance: parseImportance(memoryPatternsRaw) ?? 0.4,
    hotAccessThreshold:
      typeof memoryPatternsRaw?.hotAccessThreshold === "number" && memoryPatternsRaw.hotAccessThreshold >= 1
        ? Math.floor(memoryPatternsRaw.hotAccessThreshold)
        : 3,
    staleAfterDays:
      typeof memoryPatternsRaw?.staleAfterDays === "number" && memoryPatternsRaw.staleAfterDays >= 1
        ? Math.floor(memoryPatternsRaw.staleAfterDays)
        : 14,
  };

  const githubRaw = raw?.github as Record<string, unknown> | undefined;
  const github: GitHubSensorConfig = {
    enabled: parseSourceEnabled(githubRaw, enabled),
    importance: parseImportance(githubRaw) ?? 0.7,
    repo:
      typeof githubRaw?.repo === "string" && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(githubRaw.repo.trim())
        ? githubRaw.repo.trim()
        : undefined,
    includeReviewRequests: githubRaw?.includeReviewRequests !== false,
    staleIssueDays:
      typeof githubRaw?.staleIssueDays === "number" && githubRaw.staleIssueDays >= 1
        ? Math.floor(githubRaw.staleIssueDays)
        : 7,
  };

  const haAnomalyRaw = raw?.homeAssistantAnomaly as Record<string, unknown> | undefined;
  const homeAssistantAnomaly: HomeAssistantAnomalySensorConfig = {
    enabled: parseSourceEnabled(haAnomalyRaw, enabled),
    importance: parseImportance(haAnomalyRaw) ?? 0.8,
    watchEntities: Array.isArray(haAnomalyRaw?.watchEntities)
      ? (haAnomalyRaw.watchEntities as unknown[]).filter((e): e is string => typeof e === "string")
      : [],
  };

  const systemHealthRaw = raw?.systemHealth as Record<string, unknown> | undefined;
  const systemHealth: SystemHealthSensorConfig = {
    enabled: parseSourceEnabled(systemHealthRaw, enabled),
    importance: parseImportance(systemHealthRaw) ?? 0.7,
  };

  const weatherRaw = raw?.weather as Record<string, unknown> | undefined;
  const weather: WeatherSensorConfig = {
    enabled: parseSourceEnabled(weatherRaw, enabled),
    importance: parseImportance(weatherRaw) ?? 0.3,
    location:
      typeof weatherRaw?.location === "string" && weatherRaw.location.trim().length > 0
        ? weatherRaw.location.trim()
        : undefined,
  };

  const yarboRaw = raw?.yarbo as Record<string, unknown> | undefined;
  const yarbo: YarboSensorConfig = {
    enabled: parseSourceEnabled(yarboRaw, enabled),
    importance: parseImportance(yarboRaw) ?? 0.6,
    entityPrefix:
      typeof yarboRaw?.entityPrefix === "string" && yarboRaw.entityPrefix.trim().length > 0
        ? yarboRaw.entityPrefix.trim()
        : "sensor.yarbo",
  };

  return {
    enabled,
    schedule,
    dedupCooldownHours,
    homeAssistant,
    garmin,
    sessionHistory,
    memoryPatterns,
    github,
    homeAssistantAnomaly,
    systemHealth,
    weather,
    yarbo,
  };
}
