import { describe, it, expect } from "vitest";

import * as pluginSdk from "openclaw/plugin-sdk";

import { stringEnum } from "../utils/string-enum.js";
import { registerIssueTools } from "../tools/issue-tools.js";

function collectConstStrings(schema: unknown): string[] {
  const out: string[] = [];
  const queue: unknown[] = [schema];

  while (queue.length > 0) {
    const current = queue.shift() as Record<string, unknown> | undefined;
    if (!current || typeof current !== "object") continue;

    if (typeof current.const === "string") {
      out.push(current.const);
    }

    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const next = current[key];
      if (Array.isArray(next)) queue.push(...next);
    }

    if (current.items) queue.push(current.items);
    if (current.properties && typeof current.properties === "object") {
      queue.push(...Object.values(current.properties as Record<string, unknown>));
    }
  }

  return out;
}

describe("stringEnum compatibility", () => {
  it("does not rely on openclaw/plugin-sdk exporting stringEnum", () => {
    expect((pluginSdk as Record<string, unknown>).stringEnum).toBeUndefined();
  });

  it("builds enum-like literal unions via local helper", () => {
    const schema = stringEnum(["save", "restore"]);
    expect(collectConstStrings(schema)).toEqual(expect.arrayContaining(["save", "restore"]));
  });

  it("registers issue tools with enum parameter schemas using local helper", () => {
    const tools: Array<Record<string, unknown>> = [];
    const api = {
      registerTool: (tool: Record<string, unknown>) => tools.push(tool),
    };

    registerIssueTools({ issueStore: {} as never }, api as never);

    const createTool = tools.find((tool) => tool.name === "memory_issue_create");
    expect(createTool).toBeDefined();

    const severitySchema = (createTool as { parameters: { properties: { severity: unknown } } }).parameters.properties
      .severity;

    expect(collectConstStrings(severitySchema)).toEqual(
      expect.arrayContaining(["low", "medium", "high", "critical"]),
    );
  });
});
