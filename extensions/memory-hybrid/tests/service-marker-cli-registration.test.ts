/**
 * Test: CLI registration should work even when service markers are present (Issue #1209 regression)
 *
 * Verifies that `openclaw hybrid-mem` CLI commands remain available even when
 * OPENCLAW_SERVICE_KIND or OPENCLAW_SERVICE_MARKER environment variables leak
 * into the CLI environment from cron/service contexts.
 */

import { beforeEach, describe, expect, it } from "vitest";
import memoryHybridPlugin from "../index.js";

describe("CLI registration with service markers (Issue #1209 regression)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Restore original environment before each test
    process.env = { ...originalEnv };
  });

  it("should register CLI metadata even when OPENCLAW_SERVICE_KIND is present", () => {
    // Set service marker that would leak from gateway/service context
    process.env.OPENCLAW_SERVICE_KIND = "gateway";

    let cliRegistered = false;
    let cliDescriptors: Array<{ name: string; description?: string }> = [];

    const mockApi = {
      registrationMode: "cli-metadata" as const,
      version: "1.0.0",
      pluginConfig: {},
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      },
      registerCli: (fn: () => void, opts?: { descriptors?: Array<{ name: string; description?: string }> }) => {
        cliRegistered = true;
        if (opts?.descriptors) {
          cliDescriptors = opts.descriptors;
        }
      },
      registerTool: () => {},
      registerService: () => {},
      context: undefined,
    };

    // Call register with cli-metadata mode
    memoryHybridPlugin.register(mockApi as any);

    // Verify CLI was registered despite service marker being present
    expect(cliRegistered).toBe(true);
    expect(cliDescriptors).toHaveLength(1);
    expect(cliDescriptors[0].name).toBe("hybrid-mem");
  });

  it("should register CLI metadata even when OPENCLAW_SERVICE_MARKER is present", () => {
    // Set service marker
    process.env.OPENCLAW_SERVICE_MARKER = "1";

    let cliRegistered = false;

    const mockApi = {
      registrationMode: "cli-metadata" as const,
      version: "1.0.0",
      pluginConfig: {},
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      },
      registerCli: (fn: () => void, opts?: { descriptors?: Array<{ name: string }> }) => {
        cliRegistered = true;
      },
      registerTool: () => {},
      registerService: () => {},
      context: undefined,
    };

    memoryHybridPlugin.register(mockApi as any);

    expect(cliRegistered).toBe(true);
  });

  it("should register CLI metadata when both service markers are present", () => {
    // Set both markers (worst case scenario from leaked cron environment)
    process.env.OPENCLAW_SERVICE_KIND = "gateway";
    process.env.OPENCLAW_SERVICE_MARKER = "1";

    let cliRegistered = false;

    const mockApi = {
      registrationMode: "cli-metadata" as const,
      version: "1.0.0",
      pluginConfig: {},
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      },
      registerCli: (fn: () => void, opts?: { descriptors?: Array<{ name: string }> }) => {
        cliRegistered = true;
      },
      registerTool: () => {},
      registerService: () => {},
      context: undefined,
    };

    memoryHybridPlugin.register(mockApi as any);

    expect(cliRegistered).toBe(true);
  });

  it("should still register CLI metadata when OPENCLAW_SKIP_HYBRID_MEMORY_CLI is present (shouldn't be set in normal cron)", () => {
    // This env var is specifically for skipping hybrid-mem CLI, but during cli-metadata
    // registration phase, even this should not prevent registration
    process.env.OPENCLAW_SKIP_HYBRID_MEMORY_CLI = "1";

    let cliRegistered = false;

    const mockApi = {
      registrationMode: "cli-metadata" as const,
      version: "1.0.0",
      pluginConfig: {},
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      },
      registerCli: (fn: () => void, opts?: { descriptors?: Array<{ name: string }> }) => {
        cliRegistered = true;
      },
      registerTool: () => {},
      registerService: () => {},
      context: undefined,
    };

    memoryHybridPlugin.register(mockApi as any);

    // Even with skip flag, CLI metadata should register
    // (the skip flag should only affect full registration, not metadata)
    expect(cliRegistered).toBe(true);
  });
});
