import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigOutputSink } from "../cli/config-output-sink.js";

describe("createConfigOutputSink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes valid JSON payloads to stdout in json mode", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    createConfigOutputSink("json").log('{"ok":true}');
    expect(stdoutSpy).toHaveBeenCalledWith('{"ok":true}\n');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("routes non-JSON diagnostic lines to stderr in json mode", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    createConfigOutputSink("json").log("warning: fallback config path missing");
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith("warning: fallback config path missing");
  });

  it("uses console.log in text mode", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    createConfigOutputSink("text").log("hello");
    expect(logSpy).toHaveBeenCalledWith("hello");
    expect(stdoutSpy).not.toHaveBeenCalledWith("hello\n");
  });
});
