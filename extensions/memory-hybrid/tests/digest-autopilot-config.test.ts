import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { hybridConfigSchema } from "../config.js";

function baseConfig(sqlitePath: string): Record<string, unknown> {
  return {
    embedding: {
      apiKey: "sk-test-embed-key-that-is-long-enough",
      model: "text-embedding-3-small",
    },
    sqlitePath,
    lanceDbPath: join(dirname(sqlitePath), "lancedb"),
    credentials: { enabled: false },
    wal: { enabled: false },
    personaProposals: { enabled: true },
    verification: { enabled: false },
    provenance: { enabled: false },
    nightlyCycle: { enabled: false },
  };
}

describe("digest autopilot config parsing", () => {
  it("defaults to disabled dry-run with conservative policies", () => {
    const cfg = hybridConfigSchema.parse(baseConfig("/tmp/hm-config-defaults.db"));
    expect(cfg.digest.autopilot).toMatchObject({
      enabled: false,
      mode: "dry-run",
      schedule: "after-weekly-pending-digest",
      personaPolicy: "cautious",
      procedurePolicy: "auto-safe",
      verifiedPolicy: "classify",
      toolPolicy: "classify",
      crystallizationPolicy: "classify",
      notifyOnNoop: false,
      notifyOnDryRunActions: false,
      notifyOnApplyActions: true,
      notifyOnHumanReviewRequired: true,
      notifyOnFailure: true,
      guardWindowHours: 120,
      lockTtlMinutes: 120,
    });
  });

  it("accepts explicit apply mode only when configured", () => {
    const cfg = hybridConfigSchema.parse({
      ...baseConfig("/tmp/hm-config-apply.db"),
      digest: {
        autopilot: {
          enabled: true,
          mode: "apply",
        },
      },
    });
    expect(cfg.digest.autopilot.enabled).toBe(true);
    expect(cfg.digest.autopilot.mode).toBe("apply");
  });

  it("fails fast on unknown autopilot policy values", () => {
    expect(() =>
      hybridConfigSchema.parse({
        ...baseConfig("/tmp/hm-config-invalid-policy.db"),
        digest: {
          autopilot: {
            personaPolicy: "unsafe-mutate",
          },
        },
      }),
    ).toThrow(/digest\.autopilot\.personaPolicy/);
  });

  it("rejects non-boolean digest.autopilot notification flags", () => {
    expect(() =>
      hybridConfigSchema.parse({
        ...baseConfig("/tmp/hm-config-notify-string.db"),
        digest: {
          autopilot: {
            notifyOnFailure: "false",
          },
        },
      }),
    ).toThrow(/digest\.autopilot\.notifyOnFailure/);
  });
});
