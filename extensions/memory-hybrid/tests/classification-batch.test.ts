import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "../types/memory.js";
import { classifyMemoryOperationsBatch } from "../services/classification.js";

function makeEntry(id: string, text: string): MemoryEntry {
  return {
    id,
    text,
    category: "fact",
    importance: 0.8,
    createdAt: 0,
    entity: null,
    key: null,
    value: null,
    source: "test",
  } as MemoryEntry;
}

describe("classifyMemoryOperationsBatch (#862)", () => {
  it("uses one chat.completions call for multiple candidates", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify([
              { action: "NOOP", targetId: null, reason: "dup" },
              { action: "ADD", targetId: null, reason: "new" },
            ]),
          },
        },
      ],
    });
    const openai = { chat: { completions: { create } } } as unknown as OpenAI;
    const warn = vi.fn();
    const items = [
      {
        candidateText: "a",
        candidateEntity: null,
        candidateKey: null,
        existingFacts: [makeEntry("id1", "old a")],
      },
      {
        candidateText: "b",
        candidateEntity: null,
        candidateKey: null,
        existingFacts: [makeEntry("id2", "old b")],
      },
    ];
    const out = await classifyMemoryOperationsBatch(items, openai, "gpt-4.1-nano", { warn });
    expect(create).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(2);
    expect(out[0].action).toBe("NOOP");
    expect(out[1].action).toBe("ADD");
  });

  it("delegates to single-call path when length is 1", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "ADD | fresh" } }],
    });
    const openai = { chat: { completions: { create } } } as unknown as OpenAI;
    const warn = vi.fn();
    const existing = [makeEntry("x", "context")];
    const out = await classifyMemoryOperationsBatch(
      [{ candidateText: "n", candidateEntity: null, candidateKey: null, existingFacts: existing }],
      openai,
      "gpt-4.1-nano",
      { warn },
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe("ADD");
  });
});
