import { describe, expect, it, vi } from "vitest";

import { extractEntityMentionsWithLlm } from "../services/entity-enrichment.js";

describe("extractEntityMentionsWithLlm", () => {
  it("classifies standalone LLM timeouts as transient timeout pressure", async () => {
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("LLM request timeout after 120000ms")),
        },
      },
    };

    const result = await extractEntityMentionsWithLlm(
      "Acme Corporation announced a product update for enterprise customers.",
      openai as never,
      "gpt-5-mini",
    );

    expect(result.pressureSignals).toMatchObject({
      failed: true,
      transientFailure: true,
      rateLimited: false,
      timeoutFailure: true,
    });
  });
});
