import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractCronStoreJobModel,
  readAgentsPrimaryModelFromOpenclawJsonPath,
  readAgentsPrimaryModelFromOpenclawJsonRoot,
  setCronStoreJobModelFields,
} from "../utils/openclaw-agent-defaults.js";

describe("openclaw-agent-defaults", () => {
  it("readAgentsPrimaryModelFromOpenclawJsonRoot returns primary", () => {
    expect(
      readAgentsPrimaryModelFromOpenclawJsonRoot({
        agents: { defaults: { model: { primary: "azure-foundry/gpt-5.4" } } },
      }),
    ).toBe("azure-foundry/gpt-5.4");
    expect(readAgentsPrimaryModelFromOpenclawJsonRoot({})).toBeUndefined();
  });

  it("readAgentsPrimaryModelFromOpenclawJsonPath reads file", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-agent-"));
    const p = join(dir, "openclaw.json");
    writeFileSync(p, JSON.stringify({ agents: { defaults: { model: { primary: "minimax/MiniMax-M2" } } } }), "utf-8");
    expect(readAgentsPrimaryModelFromOpenclawJsonPath(p)).toBe("minimax/MiniMax-M2");
    rmSync(dir, { recursive: true, force: true });
  });

  it("extractCronStoreJobModel and setCronStoreJobModelFields", () => {
    const j: Record<string, unknown> = { payload: { model: "a" } };
    expect(extractCronStoreJobModel(j)).toBe("a");
    setCronStoreJobModelFields(j, "b/c");
    expect(j.model).toBe("b/c");
    expect((j.payload as Record<string, unknown>).model).toBe("b/c");
  });
});
