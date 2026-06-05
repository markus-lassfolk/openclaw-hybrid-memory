/**
 * Tests for parseSelfCorrectionLLMResponse — the parser that extracts the
 * remediation JSON array from self-correction LLM model output.
 *
 * Covers: strict JSON, fenced JSON, trailing text, invalid JSON, placeholder tokens.
 * These tests exercise the robustness guarantees described in the JSDoc of
 * parseSelfCorrectionLLMResponse (cmd-selfcorrection.ts) and the underlying
 * tryParseFirstJsonArray utility (utils/llm-json-array.ts).
 */

import { describe, expect, it } from "vitest";
import { parseSelfCorrectionLLMResponse } from "../cli/cmd-selfcorrection.js";

// Representative remediation item shape used across tests
const sampleItem = {
  category: "WRONG_APPROACH",
  severity: "MEDIUM",
  remediationType: "MEMORY_STORE",
  remediationContent: {
    text: "Always confirm destructive operations before proceeding.",
    entity: "Behavior",
    tags: ["safety"],
  },
  confidence: 0.9,
  reasoning: "User asked copilot to avoid deleting files without confirmation.",
};

describe("parseSelfCorrectionLLMResponse", () => {
  it("parses a strict bare JSON array", () => {
    const input = JSON.stringify([sampleItem]);
    const result = parseSelfCorrectionLLMResponse(input);
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect((result as (typeof sampleItem)[])[0].remediationType).toBe("MEMORY_STORE");
  });

  it("parses a JSON array wrapped in a ```json fenced code block", () => {
    const input = `Here are the remediation items:\n\`\`\`json\n${JSON.stringify([sampleItem])}\n\`\`\``;
    const result = parseSelfCorrectionLLMResponse(input);
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it("parses a JSON array wrapped in a plain ``` fenced code block", () => {
    const input = `\`\`\`\n${JSON.stringify([sampleItem])}\n\`\`\``;
    const result = parseSelfCorrectionLLMResponse(input);
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
  });

  it("extracts the JSON array when the model appends trailing prose explanation", () => {
    const array = JSON.stringify([sampleItem]);
    const input = `${array}\n\nThe above items address the identified correction signals. Let me know if you want more details.`;
    const result = parseSelfCorrectionLLMResponse(input);
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it("extracts the JSON array when there is preamble prose before the array", () => {
    const array = JSON.stringify([sampleItem]);
    const input = `Based on my analysis, here are the recommended corrections:\n${array}`;
    const result = parseSelfCorrectionLLMResponse(input);
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it("returns null for invalid/non-JSON content", () => {
    const result = parseSelfCorrectionLLMResponse("I was unable to identify any correction signals.");
    expect(result).toBeNull();
  });

  it("returns null for truncated/malformed JSON array", () => {
    // Truncated mid-object — a real LLM failure mode when output is too long
    const input = '[{"remediationType":"MEMORY_STORE","content":"Always confirm dest';
    const result = parseSelfCorrectionLLMResponse(input);
    expect(result).toBeNull();
  });

  it("returns null for model placeholder tokens (e.g. [[reply_to_current]])", () => {
    const result = parseSelfCorrectionLLMResponse("[[reply_to_current]]");
    expect(result).toBeNull();
  });

  it("skips preamble numeric arrays and parses the remediation array", () => {
    const input = `I found [1] issue:\n${JSON.stringify([sampleItem])}`;
    const result = parseSelfCorrectionLLMResponse(input);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
  });

  it("returns null when only non-remediation arrays are present", () => {
    const result = parseSelfCorrectionLLMResponse("I found [1] issue.");
    expect(result).toBeNull();
  });

  it("skips non-remediation object arrays and parses the remediation array", () => {
    const input = `Metadata: [{"id":1}]\n${JSON.stringify([sampleItem])}`;
    const result = parseSelfCorrectionLLMResponse(input);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
  });

  it("prefers a later remediation array over an earlier empty array", () => {
    const input = `[]\n${JSON.stringify([sampleItem])}`;
    const result = parseSelfCorrectionLLMResponse(input);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
  });

  it("returns null for empty string input", () => {
    const result = parseSelfCorrectionLLMResponse("");
    expect(result).toBeNull();
  });

  it("parses an empty JSON array (model found no incidents to correct)", () => {
    const result = parseSelfCorrectionLLMResponse("[]");
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("parses an empty JSON array followed by trailing text", () => {
    const result = parseSelfCorrectionLLMResponse("[] No corrections needed.");
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("parses a multi-item array correctly", () => {
    const items = [
      sampleItem,
      {
        category: "WRONG_APPROACH",
        severity: "LOW",
        remediationType: "TOOLS_RULE",
        remediationContent: "Prefer read-only ops first.",
        confidence: 0.8,
        reasoning: "...",
      },
    ];
    const result = parseSelfCorrectionLLMResponse(JSON.stringify(items));
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
  });

  it("accepts NO_ACTION items without remediationContent", () => {
    const input = JSON.stringify([
      {
        category: "NO_ISSUE",
        severity: "LOW",
        remediationType: "NO_ACTION",
      },
    ]);
    const result = parseSelfCorrectionLLMResponse(input);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect((result as Array<{ remediationType: string }>)[0].remediationType).toBe("NO_ACTION");
  });

  it("returns null when only actionable items are missing remediationContent", () => {
    const input = JSON.stringify([
      {
        category: "WRONG_APPROACH",
        severity: "MEDIUM",
        remediationType: "MEMORY_STORE",
      },
    ]);
    const result = parseSelfCorrectionLLMResponse(input);
    expect(result).toBeNull();
  });

  it("skips remediationType-only object arrays and parses a later valid remediation array", () => {
    const malformed = [{ remediationType: "MEMORY_STORE" }];
    const input = `${JSON.stringify(malformed)}\n${JSON.stringify([sampleItem])}`;
    const result = parseSelfCorrectionLLMResponse(input);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect((result as (typeof sampleItem)[])[0].remediationType).toBe("MEMORY_STORE");
  });

  it("accepts NO_ACTION items when remediationContent is omitted", () => {
    const items = [{ remediationType: "NO_ACTION", category: "INFO", severity: "LOW" }];
    const result = parseSelfCorrectionLLMResponse(JSON.stringify(items));
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect((result as { remediationType: string }[])[0].remediationType).toBe("NO_ACTION");
  });

  it("rejects actionable remediation items when remediationContent is omitted", () => {
    const items = [{ remediationType: "TOOLS_RULE", category: "WRONG_APPROACH", severity: "MEDIUM" }];
    const result = parseSelfCorrectionLLMResponse(JSON.stringify(items));
    expect(result).toBeNull();
  });

  it("extracts remediation items from MiniMax M3-style object.items payload", () => {
    const input = JSON.stringify({ items: [sampleItem] });
    const result = parseSelfCorrectionLLMResponse(input);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect((result as Array<{ remediationType: string }>)[0].remediationType).toBe("MEMORY_STORE");
  });

  it("extracts remediation items from nested tool-call arguments object", () => {
    const input = JSON.stringify({ arguments: { items: [sampleItem] } });
    const result = parseSelfCorrectionLLMResponse(input);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
  });

  it("extracts remediation items from tool_calls function.arguments string", () => {
    const input = JSON.stringify({
      tool_calls: [
        {
          type: "function",
          function: {
            name: "self_correction_result",
            arguments: JSON.stringify({ items: [sampleItem] }),
          },
        },
      ],
    });
    const result = parseSelfCorrectionLLMResponse(input);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
  });

  it("rejects MiniMax M3-style objects that contain no remediation items", () => {
    const input = JSON.stringify({ arguments: { items: [{ id: 1, text: "not a remediation" }] } });
    const result = parseSelfCorrectionLLMResponse(input);
    expect(result).toBeNull();
  });

  it("handles a fenced block with trailing text (combined)", () => {
    const array = JSON.stringify([sampleItem]);
    const input = `\`\`\`json\n${array}\n\`\`\`\n\nI have summarized 1 correction item above.`;
    const result = parseSelfCorrectionLLMResponse(input);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
  });
});
