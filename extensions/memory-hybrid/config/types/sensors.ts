/** Sensor sweep configuration for cron-based data collection (Issue #236). */

/** Config for the Home Assistant REST API connection (Garmin, HA anomaly, Yarbo sensors). */
export type HomeAssistantSensorConfig = {
  /** Base URL for Home Assistant (e.g. "http://homeassistant.local:8123"). */
  baseUrl: string;
  /** Long-lived access token. Use "env:HA_TOKEN" to resolve from environment. */
  token: string;
  /** Request timeout in milliseconds (default: 10000). */
  timeoutMs?: number;
};

/** Per-sensor enable/importance overrides. */
export type SensorSourceConfig = {
  /** Enable this sensor (default: true when sensorSweep.enabled). */
  enabled: boolean;
  /** Default importance for events from this sensor (0.0–1.0, default: 0.5). */
  importance?: number;
};

/** Tier 1 sensor: Garmin Connect via Home Assistant entities. */
export type GarminSensorConfig = SensorSourceConfig & {
  /** Entity ID prefix filter (default: "sensor.garmin"). */
  entityPrefix?: string;
};

/** Tier 1 sensor: Session history from JSONL session logs. */
export type SessionHistorySensorConfig = SensorSourceConfig & {
  /** How many recent sessions to scan (default: 10). */
  recentSessions?: number;
};

/** Tier 1 sensor: Memory patterns from SQLite/LanceDB. */
export type MemoryPatternsSensorConfig = SensorSourceConfig & {
  /** Minimum access count to be considered "hot" (default: 3). */
  hotAccessThreshold?: number;
  /** Days without access before a fact is considered "stale" (default: 14). */
  staleAfterDays?: number;
};

/** Tier 1 sensor: GitHub status via `gh` CLI. */
export type GitHubSensorConfig = SensorSourceConfig & {
  /** Target repository in "owner/name" format (e.g. "markus-lassfolk/openclaw-hybrid-memory"). Required for cron contexts where no git checkout is present. */
  repo?: string;
  /** Include PRs assigned for review (default: true). */
  includeReviewRequests?: boolean;
  /** Include stale issues (no activity for N days, default: 7). */
  staleIssueDays?: number;
};

/** Tier 2 sensor: Home Assistant anomaly detection. */
export type HomeAssistantAnomalySensorConfig = SensorSourceConfig & {
  /** Entities to watch for anomalies (e.g. ["sensor.energy_today", "binary_sensor.front_door"]). */
  watchEntities?: string[];
};

/** Tier 2 sensor: System health (agent failure rates, memory DB growth). */
export type SystemHealthSensorConfig = SensorSourceConfig;

/** Tier 2 sensor: Weather from wttr.in. */
export type WeatherSensorConfig = SensorSourceConfig & {
  /** Location for weather query (e.g. "Helsinki" or "60.17,24.94"). Default: wttr.in "auto" (IP-based inference when omitted). */
  location?: string;
};

/** Tier 2 sensor: Yarbo robot via Home Assistant entities. */
export type YarboSensorConfig = SensorSourceConfig & {
  /** Entity ID prefix for Yarbo (default: "sensor.yarbo"). */
  entityPrefix?: string;
};

/** Master sensor sweep configuration (Issue #236). */
export type SensorSweepConfig = {
  /** Enable sensor sweeps (default: false). */
  enabled: boolean;
  /** Cron schedule for Tier 1 sweeps (default: every 4 hours). */
  schedule?: string;
  /** Dedup cooldown hours — skip re-writing same fingerprint within this window (default: 4, matching the default 4-hour cron interval). */
  dedupCooldownHours?: number;
  /** Home Assistant connection (required for Garmin, HA anomaly, Yarbo sensors). */
  homeAssistant?: HomeAssistantSensorConfig;
  /** Tier 1 — Garmin Connect sensor via HA entities. */
  garmin?: GarminSensorConfig;
  /** Tier 1 — Session history sensor. */
  sessionHistory?: SessionHistorySensorConfig;
  /** Tier 1 — Memory patterns sensor. */
  memoryPatterns?: MemoryPatternsSensorConfig;
  /** Tier 1 — GitHub sensor via `gh` CLI. */
  github?: GitHubSensorConfig;
  /** Tier 2 — Home Assistant anomaly sensor. */
  homeAssistantAnomaly?: HomeAssistantAnomalySensorConfig;
  /** Tier 2 — System health sensor. */
  systemHealth?: SystemHealthSensorConfig;
  /** Tier 2 — Weather sensor. */
  weather?: WeatherSensorConfig;
  /** Tier 2 — Yarbo robot sensor. */
  yarbo?: YarboSensorConfig;
};
