import { afterEach, describe, expect, it, vi } from "vitest";
import {
  argvHasHybridMemVerbose,
  readHybridMemVerbose,
  resolveHybridMemVerbose,
  type CommanderOptsParent,
} from "../cli/global-verbose.js";

describe("resolveHybridMemVerbose", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("detects --verbose in raw argv after hybrid-mem when Commander opts are false", () => {
    expect(
      argvHasHybridMemVerbose(["node", "openclaw", "hybrid-mem", "generate-proposals", "--verbose"]),
    ).toBe(true);
    expect(
      resolveHybridMemVerbose({ verbose: false }, undefined, [
        "node",
        "openclaw",
        "hybrid-mem",
        "generate-proposals",
        "--verbose",
      ]),
    ).toBe(true);
  });

  it("detects parent hybrid-mem -v via Commander chain", () => {
    const leaf: CommanderOptsParent = {
      opts: () => ({ verbose: false }),
      parent: { opts: () => ({ verbose: true }), parent: null },
    };
    expect(readHybridMemVerbose(leaf)).toBe(true);
    expect(resolveHybridMemVerbose({ verbose: false }, leaf)).toBe(true);
  });

  it("honours HYBRID_MEMORY_VERBOSE=1", () => {
    vi.stubEnv("HYBRID_MEMORY_VERBOSE", "1");
    expect(resolveHybridMemVerbose({ verbose: false })).toBe(true);
  });
});
