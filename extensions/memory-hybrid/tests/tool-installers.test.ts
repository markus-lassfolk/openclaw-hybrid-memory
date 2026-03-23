import { describe, expect, it } from "vitest";
import { toolInstallers } from "../setup/tool-installers.js";

describe("tool installers", () => {
  it("keeps core installers ahead of optional feature installers", () => {
    expect(toolInstallers.map((installer) => `${installer.bootstrapPhase}:${installer.id}`)).toEqual([
      "core:memoryCore",
      "core:retrievalGraph",
      "core:memoryUtility",
      "optional:provenance",
      "optional:credentials",
      "optional:persona",
      "optional:documents",
      "optional:verification",
      "optional:issues",
      "optional:workflow",
      "optional:crystallization",
      "optional:selfExtension",
      "optional:apitap",
      "optional:dashboard",
    ]);
  });
});
