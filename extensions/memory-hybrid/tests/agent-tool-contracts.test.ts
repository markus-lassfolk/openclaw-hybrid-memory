import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT_TOOL_CONTRACT_NAMES } from "../contracts/agent-tool-names.js";

const hybridRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(hybridRoot, "openclaw.plugin.json");

function sortedCopy(names: readonly string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

describe("agent tool contracts", () => {
  it("openclaw.plugin.json contracts.tools matches AGENT_TOOL_CONTRACT_NAMES", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      contracts?: { tools?: string[] };
    };
    const fromManifest = sortedCopy(manifest.contracts?.tools ?? []);
    const fromSource = sortedCopy(AGENT_TOOL_CONTRACT_NAMES);
    expect(fromManifest).toEqual(fromSource);
  });

  it("declares every name once (sorted source list)", () => {
    const set = new Set<string>();
    for (const n of AGENT_TOOL_CONTRACT_NAMES) {
      expect(set.has(n)).toBe(false);
      set.add(n);
    }
  });
});
