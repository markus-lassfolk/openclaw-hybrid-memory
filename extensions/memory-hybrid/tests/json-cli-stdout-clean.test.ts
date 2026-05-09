import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
/**
 * Regression tests for issue #1230 / #1234: hybrid-mem --json commands must emit pure JSON on stdout.
 *
 * Plugin startup logs/warnings must go to stderr to avoid breaking cron harnesses and JSON parsers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isHybridMemJsonInvocation, wrapApiLoggerStderrForJsonCli } from "../utils/hybrid-mem-json-cli.js";

describe("isHybridMemJsonInvocation", () => {
  it("detects --json flag", () => {
    expect(isHybridMemJsonInvocation(["node", "openclaw", "hybrid-mem", "config", "--json"])).toBe(true);
  });

  it("detects --format json", () => {
    expect(isHybridMemJsonInvocation(["node", "openclaw", "hybrid-mem", "config", "--format", "json"])).toBe(true);
  });

  it("detects --format=json", () => {
    expect(isHybridMemJsonInvocation(["node", "openclaw", "hybrid-mem", "config", "--format=json"])).toBe(true);
  });

  it("returns false for --format text", () => {
    expect(isHybridMemJsonInvocation(["node", "openclaw", "hybrid-mem", "config", "--format", "text"])).toBe(false);
  });

  it("returns false when no JSON flag present", () => {
    expect(isHybridMemJsonInvocation(["node", "openclaw", "hybrid-mem", "config"])).toBe(false);
  });

  it("stops at -- separator", () => {
    expect(isHybridMemJsonInvocation(["node", "openclaw", "hybrid-mem", "store", "--", "--json"])).toBe(false);
  });

  it("returns false when hybrid-mem not in argv", () => {
    expect(isHybridMemJsonInvocation(["node", "openclaw", "config", "--json"])).toBe(false);
  });

  it("handles multiple commands with --json", () => {
    expect(isHybridMemJsonInvocation(["node", "openclaw", "hybrid-mem", "verify", "--json"])).toBe(true);
    expect(isHybridMemJsonInvocation(["node", "openclaw", "hybrid-mem", "stats", "--json"])).toBe(true);
    expect(isHybridMemJsonInvocation(["node", "openclaw", "hybrid-mem", "validate-cron-exit", "--json"])).toBe(true);
  });

  it("handles --json before subcommand", () => {
    expect(isHybridMemJsonInvocation(["node", "openclaw", "hybrid-mem", "--json", "config"])).toBe(true);
  });

  it("handles --format=json with equals sign", () => {
    expect(isHybridMemJsonInvocation(["node", "openclaw", "hybrid-mem", "config", "--format=json"])).toBe(true);
  });

  it("rejects --format=markdown", () => {
    expect(isHybridMemJsonInvocation(["node", "openclaw", "hybrid-mem", "config", "--format=markdown"])).toBe(false);
  });

  it("rejects --json in wrong context", () => {
    expect(isHybridMemJsonInvocation(["node", "some-other-cli", "--json"])).toBe(false);
  });
});

describe("wrapApiLoggerStderrForJsonCli", () => {
  const savedArgv = [...process.argv];

  afterEach(() => {
    process.argv = [...savedArgv];
    vi.restoreAllMocks();
  });

  it("returns the same api reference when not a JSON hybrid-mem invocation", () => {
    process.argv = ["node", "openclaw", "hybrid-mem", "config"];
    const api = { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as ClawdbotPluginApi;
    expect(wrapApiLoggerStderrForJsonCli(api)).toBe(api);
  });

  it("routes logger methods to stderr and does not call the original api.logger", () => {
    process.argv = ["node", "openclaw", "hybrid-mem", "config", "--json"];
    const origInfo = vi.fn();
    const origWarn = vi.fn();
    const api = {
      logger: { info: origInfo, warn: origWarn, error: vi.fn(), debug: vi.fn() },
    } as unknown as ClawdbotPluginApi;

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const wrapped = wrapApiLoggerStderrForJsonCli(api);
    expect(wrapped).not.toBe(api);

    wrapped.logger.info("telemetry");
    wrapped.logger.warn("warn");

    expect(errSpy).toHaveBeenCalledWith("telemetry");
    expect(errSpy).toHaveBeenCalledWith("warn");
    expect(origInfo).not.toHaveBeenCalled();
    expect(origWarn).not.toHaveBeenCalled();
  });
});
