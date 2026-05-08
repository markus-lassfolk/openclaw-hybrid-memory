/**
 * Issue #1224 — per-subcommand `--verbose` and immediate exit on unknown options
 * (no hang when OpenClaw uses commander.exitOverride without process.exit).
 */

import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { attachHybridMemCliFatalExit, ensureVerboseFlagOnHybridMemTree } from "../cli/hybrid-mem-commander-utils.js";

describe("hybrid-mem commander helpers (#1224)", () => {
  it("rejects config --verbose when the leaf has no --verbose (no parent -v to absorb the flag)", async () => {
    const program = new Command();
    program.exitOverride((err) => {
      throw err;
    });
    const mem = program.command("hybrid-mem");
    mem.enablePositionalOptions();
    // No global hybrid-mem -v: simulates per-subcommand validation (Issue #1224).
    mem
      .command("config")
      .description("x")
      .action(() => {});
    await expect(program.parseAsync(["hybrid-mem", "config", "--verbose"], { from: "user" })).rejects.toMatchObject({
      code: "commander.unknownOption",
    });
  });

  it("accepts config --verbose after ensureVerboseFlagOnHybridMemTree", async () => {
    const program = new Command();
    program.exitOverride((err) => {
      throw err;
    });
    const mem = program.command("hybrid-mem");
    mem.option("-v, --verbose", "t", false);
    mem.enablePositionalOptions();
    mem
      .command("config")
      .description("x")
      .action(() => {});
    ensureVerboseFlagOnHybridMemTree(mem);
    await program.parseAsync(["hybrid-mem", "config", "--verbose"], { from: "user" });
  });

  it("accepts verify --verbose after ensureVerboseFlagOnHybridMemTree", async () => {
    const program = new Command();
    program.exitOverride((err) => {
      throw err;
    });
    const mem = program.command("hybrid-mem");
    mem.option("-v, --verbose", "t", false);
    mem.enablePositionalOptions();
    mem
      .command("verify")
      .option("--fix", "x")
      .action(() => {});
    ensureVerboseFlagOnHybridMemTree(mem);
    await program.parseAsync(["hybrid-mem", "verify", "--verbose"], { from: "user" });
  });

  it("accepts audit-health --format json --timeout-ms 30000 --verbose", async () => {
    const program = new Command();
    program.exitOverride((err) => {
      throw err;
    });
    const mem = program.command("hybrid-mem");
    mem.option("-v, --verbose", "t", false);
    mem.enablePositionalOptions();
    mem
      .command("audit-health")
      .option("--format <format>", "f", "markdown")
      .option("--timeout-ms <n>", "t", "30000")
      .action(() => {});
    ensureVerboseFlagOnHybridMemTree(mem);
    await program.parseAsync(["hybrid-mem", "audit-health", "--format", "json", "--timeout-ms", "30000", "--verbose"], {
      from: "user",
    });
  });

  it("calls teardown and process.exit(1) on unknown options when attachHybridMemCliFatalExit is used", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const teardown = vi.fn().mockResolvedValue(undefined);
    try {
      const program = new Command();
      const mem = program.command("hybrid-mem");
      mem.option("-v, --verbose", "t", false);
      mem.enablePositionalOptions();
      attachHybridMemCliFatalExit(mem, teardown);
      mem
        .command("config")
        .description("x")
        .action(() => {});
      ensureVerboseFlagOnHybridMemTree(mem);
      await expect(
        program.parseAsync(["hybrid-mem", "config", "--not-a-real-option"], { from: "user" }),
      ).rejects.toMatchObject({ code: "commander.unknownOption" });
      expect(teardown).toHaveBeenCalled();
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    } finally {
      exitSpy.mockRestore();
    }
  });
});
