import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
/**
 * Regression tests for issue #1230 / #1234: hybrid-mem --json commands must emit pure JSON on stdout.
 *
 * Plugin startup logs/warnings must go to stderr to avoid breaking cron harnesses and JSON parsers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isHybridMemJsonInvocation,
  restoreStdoutAfterJsonCli,
  withJsonCliStdoutMirrorSuppressed,
  wrapApiLoggerStderrForJsonCli,
} from "../utils/hybrid-mem-json-cli.js";

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
  const savedStdoutWrite = process.stdout.write;
  const savedStderrWrite = process.stderr.write;

  afterEach(() => {
    restoreStdoutAfterJsonCli();
    process.stdout.write = savedStdoutWrite;
    process.stderr.write = savedStderrWrite;
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

  it("mirrors non-JSON stdout writes to stderr while preserving the original stdout write result", () => {
    process.argv = ["node", "openclaw", "hybrid-mem", "config", "--json"];
    const stdoutWrite = vi.fn(() => false);
    const stderrWrite = vi.fn(() => true);
    process.stdout.write = stdoutWrite as unknown as typeof process.stdout.write;
    process.stderr.write = stderrWrite as unknown as typeof process.stderr.write;

    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as ClawdbotPluginApi;
    wrapApiLoggerStderrForJsonCli(api);

    const result = process.stdout.write(Buffer.from("bootstrap log\n"));

    expect(result).toBe(false);
    expect(stdoutWrite).toHaveBeenCalledWith(Buffer.from("bootstrap log\n"));
    expect(stderrWrite).toHaveBeenCalledWith(Buffer.from("bootstrap log\n"));
    restoreStdoutAfterJsonCli();
    expect(process.stdout.write).toBe(stdoutWrite);
  });

  it("does not mirror final JSON payload writes to stderr", () => {
    process.argv = ["node", "openclaw", "hybrid-mem", "config", "--json"];
    const stdoutWrite = vi.fn(() => true);
    const stderrWrite = vi.fn(() => true);
    process.stdout.write = stdoutWrite as unknown as typeof process.stdout.write;
    process.stderr.write = stderrWrite as unknown as typeof process.stderr.write;

    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as ClawdbotPluginApi;
    wrapApiLoggerStderrForJsonCli(api);

    const payload = `${JSON.stringify({ ok: true })}\n`;
    const result = process.stdout.write(payload);

    expect(result).toBe(true);
    expect(stdoutWrite).toHaveBeenCalledWith(payload);
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it("allows explicit suppression for JSON payload writes", () => {
    process.argv = ["node", "openclaw", "hybrid-mem", "config", "--json"];
    const stdoutWrite = vi.fn(() => true);
    const stderrWrite = vi.fn(() => true);
    process.stdout.write = stdoutWrite as unknown as typeof process.stdout.write;
    process.stderr.write = stderrWrite as unknown as typeof process.stderr.write;

    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as ClawdbotPluginApi;
    wrapApiLoggerStderrForJsonCli(api);

    withJsonCliStdoutMirrorSuppressed(() => {
      process.stdout.write('{"ok":true}\n');
    });

    expect(stdoutWrite).toHaveBeenCalledWith('{"ok":true}\n');
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it("restores the original stdout write even when teardown runs without a JSON argv", () => {
    process.argv = ["node", "openclaw", "hybrid-mem", "config", "--json"];
    const stdoutWrite = vi.fn(() => true);
    process.stdout.write = stdoutWrite as unknown as typeof process.stdout.write;

    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as ClawdbotPluginApi;
    wrapApiLoggerStderrForJsonCli(api);
    expect(process.stdout.write).not.toBe(stdoutWrite);

    process.argv = ["node", "openclaw", "hybrid-mem", "config"];
    restoreStdoutAfterJsonCli();

    expect(process.stdout.write).toBe(stdoutWrite);
  });

  it("treats stdout EPIPE as best-effort and still mirrors diagnostics to stderr", () => {
    process.argv = ["node", "openclaw", "hybrid-mem", "config", "--json"];
    const epipe = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    const stdoutWrite = vi.fn(() => {
      throw epipe;
    });
    const stderrWrite = vi.fn(() => true);
    process.stdout.write = stdoutWrite as unknown as typeof process.stdout.write;
    process.stderr.write = stderrWrite as unknown as typeof process.stderr.write;

    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as ClawdbotPluginApi;
    wrapApiLoggerStderrForJsonCli(api);

    expect(() => process.stdout.write("diagnostic\n")).not.toThrow();
    expect(stderrWrite).toHaveBeenCalledWith("diagnostic\n");
  });
});
