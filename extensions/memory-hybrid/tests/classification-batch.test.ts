import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "../types/memory.js";
import { classifyMemoryOperation, classifyMemoryOperationsBatch } from "../services/classification.js";

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

  it("accepts batch response wrapped in markdown fence (#1007)", async () => {
    const inner = JSON.stringify([
      { action: "NOOP", targetId: null, reason: "dup" },
      { action: "ADD", targetId: null, reason: "new" },
    ]);
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: `Okay.\n\`\`\`json\n${inner}\n\`\`\``,
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
    expect(warn).not.toHaveBeenCalled();
    expect(out).toHaveLength(2);
    expect(out[0].action).toBe("NOOP");
    expect(out[1].action).toBe("ADD");
  });
});

describe("classify completion API params (#1008)", () => {
  it("uses max_completion_tokens for azure-foundry gpt-5 classify model (single)", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "ADD | ok" } }] });
    const openai = { chat: { completions: { create } } } as unknown as OpenAI;
    const warn = vi.fn();
    await classifyMemoryOperation(
      "new fact",
      null,
      null,
      [makeEntry("id1", "old")],
      openai,
      "azure-foundry/gpt-5.4-nano",
      {
        warn,
      },
    );
    const arg = create.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({ model: "azure-foundry/gpt-5.4-nano", max_completion_tokens: 100 });
    expect(arg).not.toHaveProperty("max_tokens");
    expect(arg.temperature).toBe(0);
  });

  it("omits temperature for o-series reasoning model (single)", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "ADD | ok" } }] });
    const openai = { chat: { completions: { create } } } as unknown as OpenAI;
    const warn = vi.fn();
    await classifyMemoryOperation("new", null, null, [makeEntry("id1", "old")], openai, "openai/o3-mini", { warn });
    const arg = create.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.max_completion_tokens).toBe(100);
    expect(arg).not.toHaveProperty("temperature");
  });

  it("uses max_completion_tokens for gpt-5 in batch path", async () => {
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
      { candidateText: "a", candidateEntity: null, candidateKey: null, existingFacts: [makeEntry("id1", "old a")] },
      { candidateText: "b", candidateEntity: null, candidateKey: null, existingFacts: [makeEntry("id2", "old b")] },
    ];
    await classifyMemoryOperationsBatch(items, openai, "azure-foundry/gpt-5.4-nano", { warn });
    const arg = create.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.max_completion_tokens).toBe(160);
    expect(arg).not.toHaveProperty("max_tokens");
  });

  it("uses max_tokens for gpt-4 style batch model (multi-candidate path)", async () => {
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
      { candidateText: "a", candidateEntity: null, candidateKey: null, existingFacts: [makeEntry("id1", "old a")] },
      { candidateText: "b", candidateEntity: null, candidateKey: null, existingFacts: [makeEntry("id2", "old b")] },
    ];
    await classifyMemoryOperationsBatch(items, openai, "gpt-4.1-nano", { warn });
    const arg = create.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.max_tokens).toBe(160);
    expect(arg).not.toHaveProperty("max_completion_tokens");
  });
});
