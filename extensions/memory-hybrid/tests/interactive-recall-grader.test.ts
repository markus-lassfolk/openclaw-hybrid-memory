import { describe, expect, it, vi } from "vitest";
import { filterCandidatesByInteractiveGrading } from "../services/interactive-recall-grader.js";
import type { SearchResult } from "../types/memory.js";

function makeCandidate(id: string, text: string): SearchResult {
  return {
    entry: {
      id,
      text,
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
      createdAt: 1,
      decayClass: "stable",
      expiresAt: null,
      lastConfirmedAt: 0,
      confidence: 1,
      scope: "global",
    },
    score: 0.9,
    backend: "sqlite",
  };
}

describe("filterCandidatesByInteractiveGrading", () => {
  const cfg = { enabled: true, interactiveRecall: true, interactiveTopN: 2 };

  it("returns all candidates when grading is disabled", async () => {
    const candidates = [makeCandidate("a", "alpha"), makeCandidate("b", "beta")];
    const out = await filterCandidatesByInteractiveGrading("q", candidates, { enabled: false }, {} as never);
    expect(out).toEqual(candidates);
  });

  it("drops head candidates when grader marks them irrelevant", async () => {
    const candidates = [makeCandidate("a", "alpha"), makeCandidate("b", "beta"), makeCandidate("c", "gamma")];
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '["no","no"]' } }],
          }),
        },
      },
    };

    const out = await filterCandidatesByInteractiveGrading("q", candidates, cfg, openai as never);
    expect(out.map((r) => r.entry.id)).toEqual([]);
  });

  it("keeps only relevant head and does not restore tail when head is all irrelevant", async () => {
    const candidates = [makeCandidate("a", "alpha"), makeCandidate("b", "beta"), makeCandidate("c", "gamma")];
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '["yes","no"]' } }],
          }),
        },
      },
    };

    const out = await filterCandidatesByInteractiveGrading("q", candidates, cfg, openai as never);
    expect(out.map((r) => r.entry.id)).toEqual(["a", "c"]);
  });

  it("fail-closed on grader errors — excludes graded head (DocumentGrader returns all no)", async () => {
    const candidates = [makeCandidate("a", "alpha"), makeCandidate("b", "beta"), makeCandidate("c", "gamma")];
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("timeout")),
        },
      },
    };

    const out = await filterCandidatesByInteractiveGrading("q", candidates, cfg, openai as never);
    expect(out).toEqual([]);
  });
});
