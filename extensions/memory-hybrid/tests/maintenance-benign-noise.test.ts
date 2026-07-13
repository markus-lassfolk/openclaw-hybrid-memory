import { describe, expect, it } from "vitest";

import {
  collectMaintenanceNoiseWarnings,
  isBenignNoiseOnlyMaintenanceStep,
  sanitizeMaintenanceLogText,
  stepHasActionableFailureSignal,
} from "../services/maintenance-benign-noise.js";

describe("maintenance-benign-noise", () => {
  const registerContextEngineLine =
    "memory-hybrid: registerContextEngine not found in SDK; skipping ContextEngine registration";
  const codexConfigLine =
    "ERROR codex_app_server: Ignored unsupported project-local config keys in /mnt/openclaw/.openclaw/workspace/.codex/config.toml: model_provider, model_providers, profiles.";

  it("sanitizes known benign warning lines from log text", () => {
    const sanitized = sanitizeMaintenanceLogText([registerContextEngineLine, "real progress line"].join("\n"));
    expect(sanitized).not.toContain("registerContextEngine");
    expect(sanitized).toContain("real progress line");
  });

  it("treats benign-only non-zero steps as noise-only", () => {
    expect(
      isBenignNoiseOnlyMaintenanceStep({
        exitCode: 1,
        logContent: codexConfigLine,
      }),
    ).toBe(true);
    expect(
      isBenignNoiseOnlyMaintenanceStep({
        exitCode: 1,
        logContent: `${codexConfigLine}\nUnhandled exception: parser timeout`,
      }),
    ).toBe(false);
  });

  it("detects actionable failure signals after benign stripping", () => {
    expect(stepHasActionableFailureSignal({ logContent: registerContextEngineLine })).toBe(false);
    expect(stepHasActionableFailureSignal({ logContent: "Unhandled exception: parser timeout" })).toBe(true);
  });

  it("preserves a real error concatenated onto the same physical line as benign noise (QA follow-up)", () => {
    const mergedLine = `${registerContextEngineLine} SQLITE_BUSY: database is locked, aborting`;
    // Whole-line removal would have dropped the real SQLITE_BUSY error along with the benign
    // notice; only the noise substring should be stripped.
    expect(sanitizeMaintenanceLogText(mergedLine)).toContain("SQLITE_BUSY");
    expect(stepHasActionableFailureSignal({ logContent: mergedLine })).toBe(true);
    expect(
      isBenignNoiseOnlyMaintenanceStep({
        exitCode: 1,
        logContent: mergedLine,
      }),
    ).toBe(false);
  });

  it("aggregates noise warnings by pattern/job/step/log path", () => {
    const warnings = collectMaintenanceNoiseWarnings([
      {
        job: "weekly-reflection",
        step: "reflect",
        logPath: "/tmp/a.log",
        logContent: [registerContextEngineLine, registerContextEngineLine].join("\n"),
      },
      {
        job: "nightly-memory-sweep",
        step: "extract-daily",
        logPath: "/tmp/b.log",
        logContent: codexConfigLine,
      },
    ]);

    expect(warnings).toHaveLength(2);
    expect(warnings.find((w) => w.patternId === "register-context-engine-missing")?.occurrenceCount).toBe(2);
    expect(warnings.find((w) => w.patternId === "codex-unsupported-project-local-config")?.classification).toBe(
      "benign_noise",
    );
  });
});
