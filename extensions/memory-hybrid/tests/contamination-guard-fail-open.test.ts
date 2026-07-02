/**
 * validateAttributionsWithLlm (contamination-guard.ts Layer 2) caught any LLM failure — timeout,
 * network error, provider 5xx, malformed response — and silently returned { allowed: true }, as
 * if attribution had been verified. In contaminationGuard==="enforce" mode (the strictest
 * configured mode, meant to actively reject and quarantine contaminated facts), a transient LLM
 * failure meant an unverified fact was stored as a normal memory instead of being quarantined —
 * defeating the entire purpose of "enforce" mode, silently.
 */
import { describe, expect, it, vi } from "vitest";
import * as chatModule from "../services/chat.js";
import { runContaminationGuard, validateAttributionsWithLlm } from "../services/contamination-guard.js";

describe("contamination-guard LLM layer fail-closed behavior", () => {
  it("fails closed (allowed:false) when the LLM call throws", async () => {
    const chatCompleteSpy = vi.spyOn(chatModule, "chatComplete").mockRejectedValue(new Error("timeout after 8000ms"));
    try {
      const result = await validateAttributionsWithLlm(
        "Draft claiming Acme Corp merged with Foo Inc",
        ["source text"],
        {} as never,
      );
      expect(result.allowed).toBe(false);
      expect(result.layer).toBe("llm");
      expect(result.reason).toContain("timeout after 8000ms");
    } finally {
      chatCompleteSpy.mockRestore();
    }
  });

  it("still allows through when the LLM says YES", async () => {
    const chatCompleteSpy = vi.spyOn(chatModule, "chatComplete").mockResolvedValue("YES");
    try {
      const result = await validateAttributionsWithLlm("Draft", ["source"], {} as never);
      expect(result.allowed).toBe(true);
    } finally {
      chatCompleteSpy.mockRestore();
    }
  });

  it("still rejects when the LLM says NO", async () => {
    const chatCompleteSpy = vi.spyOn(chatModule, "chatComplete").mockResolvedValue("NO");
    try {
      const result = await validateAttributionsWithLlm("Draft", ["source"], {} as never);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("LLM rejected attributions");
    } finally {
      chatCompleteSpy.mockRestore();
    }
  });

  it("runContaminationGuard propagates the fail-closed result in enforce mode (skipLlm=false)", async () => {
    const chatCompleteSpy = vi.spyOn(chatModule, "chatComplete").mockRejectedValue(new Error("network error"));
    try {
      // Every proper-noun-shaped token in the draft ("Acme Corp") also appears in the source
      // text, so Layer 1 (deterministic entity check) passes and this actually reaches Layer 2
      // (the LLM check under test) — a draft entity absent from the source would be rejected by
      // Layer 1 before the LLM is ever called.
      const result = await runContaminationGuard("Acme Corp expanded operations", ["Acme Corp expanded operations report"], [], {
        openai: {} as never,
        skipLlm: false,
      });
      expect(result.allowed).toBe(false);
      expect(result.layer).toBe("llm");
    } finally {
      chatCompleteSpy.mockRestore();
    }
  });
});
