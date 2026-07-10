import { describe, expect, it } from "vitest";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

import { registerWorkshopTools, type WorkshopToolsContext } from "../tools/workshop-tool.js";

type CapturedWorkshopTool = {
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
};

function captureWorkshopTool(cfg: WorkshopToolsContext["cfg"]): CapturedWorkshopTool {
  let registeredTool: CapturedWorkshopTool | null = null;
  const api = {
    registerTool(tool: CapturedWorkshopTool) {
      registeredTool = tool;
    },
    logger: {},
    context: {},
  } as unknown as ClawdbotPluginApi;

  registerWorkshopTools(
    {
      cfg,
      factsDb: {} as never,
      resolvedSqlitePath: ":memory:",
    },
    api,
  );

  if (!registeredTool) throw new Error("memory_workshop was not registered");
  return registeredTool;
}

describe("memory_workshop agent mutation guard", () => {
  it("blocks mutating tool actions unless explicitly opted in", async () => {
    const tool = captureWorkshopTool({ workshop: { enabled: true }, procedures: { enabled: true } } as never);

    expect(tool.description).toContain("Read-only");
    const actionSchema = (tool.parameters as { properties: { action: unknown } }).properties.action;
    expect(JSON.stringify(actionSchema)).not.toContain('"approve"');
    const result = (await tool.execute("call-1", { action: "approve", id: "procedure-skill:abc" })) as {
      details: { ok: boolean; error: string };
      content: Array<{ text: string }>;
    };

    expect(result.details).toEqual({ ok: false, error: "workshop_agent_mutations_disabled" });
    expect(result.content[0].text).toContain("disabled for agent tool calls");
  });

  it("advertises mutating actions only after explicit opt-in", () => {
    const tool = captureWorkshopTool({ workshop: { enabled: true, allowAgentMutations: true } } as never);

    expect(tool.description).toContain("approve");
    expect(tool.description).not.toContain("Read-only");
    const actionSchema = (tool.parameters as { properties: { action: unknown } }).properties.action;
    expect(JSON.stringify(actionSchema)).toContain('"approve"');
  });
});
