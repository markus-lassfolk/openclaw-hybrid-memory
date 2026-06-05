import { describe, expect, it } from "vitest";
import {
  currentTurnSlice,
  extractToolNamesFromMessages,
  inferWorkflowOutcomeFromMessages,
} from "../services/workflow-message-utils.js";

describe("workflow-message-utils", () => {
  it("currentTurnSlice keeps messages from the last user turn", () => {
    const slice = currentTurnSlice([
      { role: "user", content: "first task" },
      { role: "assistant", content: "done" },
      { role: "user", content: "second task" },
      { role: "assistant", tool_calls: [{ function: { name: "read" } }] },
    ]);
    expect(slice).toHaveLength(2);
    expect((slice[0] as { content?: string }).content).toBe("second task");
  });

  it("extractToolNamesFromMessages reads tool_calls and tool_use blocks", () => {
    const names = extractToolNamesFromMessages([
      {
        role: "assistant",
        content: [{ type: "tool_use", name: "read", input: { path: "a.ts" } }],
      },
      {
        role: "assistant",
        tool_calls: [{ function: { name: "exec" } }],
      },
    ]);
    expect(names).toEqual(["read", "exec"]);
  });

  it("inferWorkflowOutcomeFromMessages reads flattened session JSONL text field", () => {
    expect(
      inferWorkflowOutcomeFromMessages([
        { role: "user", text: "run deploy" },
        { role: "assistant", text: "Deployed successfully." },
      ]),
    ).toBe("success");
  });

  it("inferWorkflowOutcomeFromMessages detects failure from tool errors", () => {
    expect(
      inferWorkflowOutcomeFromMessages([
        { role: "user", content: "run deploy" },
        { role: "tool", content: "Error: command failed", isError: true },
      ]),
    ).toBe("failure");
    expect(
      inferWorkflowOutcomeFromMessages([
        { role: "user", content: "run deploy" },
        { role: "assistant", content: "Deployed successfully." },
      ]),
    ).toBe("success");
  });
});
