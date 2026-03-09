/**
 * Tests for Issue #281: Cron reliability config parsing for memory maintenance.
 * Covers config parsing of maintenance.cronReliability.
 */

import { describe, it, expect } from "vitest";
import { hybridConfigSchema } from "../config.js";

// ---------------------------------------------------------------------------
// Config: maintenance.cronReliability parsing
// ---------------------------------------------------------------------------

describe("config maintenance.cronReliability parsing", () => {
  const baseConfig = {
    embedding: { provider: "openai" as const, model: "text-embedding-3-small", apiKey: "sk-test-key-that-is-long-enough" },
    lanceDbPath: "/tmp/test-lance",
    sqlitePath: "/tmp/test.db",
  };

  it("defaults: nightlyCron='0 3 * * *', weeklyBackupCron='0 4 * * 0', verifyOnBoot=true, staleThresholdHours=28", () => {
    const cfg = hybridConfigSchema.parse(baseConfig);
    const rel = cfg.maintenance.cronReliability;
    expect(rel.nightlyCron).toBe("0 3 * * *");
    expect(rel.weeklyBackupCron).toBe("0 4 * * 0");
    expect(rel.verifyOnBoot).toBe(true);
    expect(rel.staleThresholdHours).toBe(28);
  });

  it("accepts custom nightlyCron expression", () => {
    const cfg = hybridConfigSchema.parse({
      ...baseConfig,
      maintenance: { cronReliability: { nightlyCron: "0 2 * * *" } },
    });
    expect(cfg.maintenance.cronReliability.nightlyCron).toBe("0 2 * * *");
  });

  it("accepts custom weeklyBackupCron expression", () => {
    const cfg = hybridConfigSchema.parse({
      ...baseConfig,
      maintenance: { cronReliability: { weeklyBackupCron: "0 5 * * 6" } },
    });
    expect(cfg.maintenance.cronReliability.weeklyBackupCron).toBe("0 5 * * 6");
  });

  it("accepts verifyOnBoot=false", () => {
    const cfg = hybridConfigSchema.parse({
      ...baseConfig,
      maintenance: { cronReliability: { verifyOnBoot: false } },
    });
    expect(cfg.maintenance.cronReliability.verifyOnBoot).toBe(false);
  });

  it("accepts custom staleThresholdHours", () => {
    const cfg = hybridConfigSchema.parse({
      ...baseConfig,
      maintenance: { cronReliability: { staleThresholdHours: 48 } },
    });
    expect(cfg.maintenance.cronReliability.staleThresholdHours).toBe(48);
  });

  it("falls back to default nightlyCron when empty string given", () => {
    const cfg = hybridConfigSchema.parse({
      ...baseConfig,
      maintenance: { cronReliability: { nightlyCron: "" } },
    });
    expect(cfg.maintenance.cronReliability.nightlyCron).toBe("0 3 * * *");
  });

  it("falls back to default weeklyBackupCron when whitespace-only given", () => {
    const cfg = hybridConfigSchema.parse({
      ...baseConfig,
      maintenance: { cronReliability: { weeklyBackupCron: "   " } },
    });
    expect(cfg.maintenance.cronReliability.weeklyBackupCron).toBe("0 4 * * 0");
  });

  it("floors decimal staleThresholdHours", () => {
    const cfg = hybridConfigSchema.parse({
      ...baseConfig,
      maintenance: { cronReliability: { staleThresholdHours: 24.9 } },
    });
    expect(cfg.maintenance.cronReliability.staleThresholdHours).toBe(24);
  });

  it("falls back to default staleThresholdHours when 0 given", () => {
    const cfg = hybridConfigSchema.parse({
      ...baseConfig,
      maintenance: { cronReliability: { staleThresholdHours: 0 } },
    });
    expect(cfg.maintenance.cronReliability.staleThresholdHours).toBe(28);
  });

  it("falls back to default staleThresholdHours when negative given", () => {
    const cfg = hybridConfigSchema.parse({
      ...baseConfig,
      maintenance: { cronReliability: { staleThresholdHours: -5 } },
    });
    expect(cfg.maintenance.cronReliability.staleThresholdHours).toBe(28);
  });

  it("cronReliability is present in all presets", () => {
    for (const mode of ["essential", "normal", "expert", "full"] as const) {
      const cfg = hybridConfigSchema.parse({ ...baseConfig, mode });
      expect(cfg.maintenance.cronReliability).toBeDefined();
      expect(typeof cfg.maintenance.cronReliability.staleThresholdHours).toBe("number");
    }
  });
});

// ---------------------------------------------------------------------------
// MaintenanceConfig shape: both new sub-configs co-exist
// ---------------------------------------------------------------------------

describe("MaintenanceConfig sub-config co-existence", () => {
  it("maintenance has monthlyReview, cronReliability, and council", () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "openai" as const, model: "text-embedding-3-small", apiKey: "sk-test-key-that-is-long-enough" },
      lanceDbPath: "/tmp/test-lance",
      sqlitePath: "/tmp/test.db",
    });
    expect(cfg.maintenance).toHaveProperty("monthlyReview");
    expect(cfg.maintenance).toHaveProperty("cronReliability");
    expect(cfg.maintenance).toHaveProperty("council");
  });

  it("all three sub-configs can be set independently", () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "openai" as const, model: "text-embedding-3-small", apiKey: "sk-test-key-that-is-long-enough" },
      lanceDbPath: "/tmp/test-lance",
      sqlitePath: "/tmp/test.db",
      maintenance: {
        monthlyReview: { enabled: true, dayOfMonth: 15 },
        cronReliability: { nightlyCron: "0 1 * * *", staleThresholdHours: 36, verifyOnBoot: false },
        council: { provenance: "meta", sessionKeyPrefix: "pr-council" },
      },
    });
    expect(cfg.maintenance.monthlyReview.enabled).toBe(true);
    expect(cfg.maintenance.monthlyReview.dayOfMonth).toBe(15);
    expect(cfg.maintenance.cronReliability.nightlyCron).toBe("0 1 * * *");
    expect(cfg.maintenance.cronReliability.staleThresholdHours).toBe(36);
    expect(cfg.maintenance.cronReliability.verifyOnBoot).toBe(false);
    expect(cfg.maintenance.council.provenance).toBe("meta");
    expect(cfg.maintenance.council.sessionKeyPrefix).toBe("pr-council");
  });
});
