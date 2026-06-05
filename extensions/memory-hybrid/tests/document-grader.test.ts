import { describe, expect, it, vi } from "vitest";
import { DocumentGrader } from "../services/document-grader.js";

describe("DocumentGrader fail-closed", () => {
  it("treats malformed grade responses as not relevant", async () => {
    const grader = new DocumentGrader({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "not json at all" } }],
          }),
        },
      },
    } as never);

    const grades = await grader.gradeDocuments("query", [
      { factId: "a", text: "alpha" },
      { factId: "b", text: "beta" },
    ]);

    expect(grades).toHaveLength(2);
    expect(grades.every((g) => g.relevant === false)).toBe(true);
  });

  it("treats LLM errors as not relevant", async () => {
    const grader = new DocumentGrader({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("timeout")),
        },
      },
    } as never);

    const grades = await grader.gradeDocuments("query", [{ factId: "a", text: "alpha" }]);
    expect(grades[0]?.relevant).toBe(false);
  });
});
