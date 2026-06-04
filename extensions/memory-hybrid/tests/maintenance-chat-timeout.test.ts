import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_CHAT_TIMEOUT_MS,
  MAINTENANCE_M3_CHAT_TIMEOUT_MS,
  MAINTENANCE_M27_THINKING_CHAT_TIMEOUT_MS,
  MAINTENANCE_THINKING_CHAT_TIMEOUT_MS,
} from "../utils/constants.js";
import { resolveMaintenanceChatTimeoutMs } from "../services/chat.js";
import * as chat from "../services/chat.js";
import { chatCompleteWithAdaptiveMaintenanceRetry } from "../services/adaptive-maintenance-llm.js";

describe("resolveMaintenanceChatTimeoutMs", () => {
  it("uses 180s for M3 with thinking", () => {
    expect(resolveMaintenanceChatTimeoutMs("MiniMax-M3", "adaptive")).toBe(MAINTENANCE_THINKING_CHAT_TIMEOUT_MS);
    expect(MAINTENANCE_THINKING_CHAT_TIMEOUT_MS).toBe(180_000);
  });

  it("uses 120s for M3 without thinking", () => {
    expect(resolveMaintenanceChatTimeoutMs("minimax/MiniMax-M3", "disabled")).toBe(MAINTENANCE_M3_CHAT_TIMEOUT_MS);
  });

  it("uses 120s for M2.7-highspeed with thinking", () => {
    expect(resolveMaintenanceChatTimeoutMs("MiniMax-M2.7-highspeed", "adaptive")).toBe(
      MAINTENANCE_M27_THINKING_CHAT_TIMEOUT_MS,
    );
  });

  it("uses default for non-MiniMax", () => {
    expect(resolveMaintenanceChatTimeoutMs("gpt-4o", "adaptive")).toBe(DEFAULT_CHAT_TIMEOUT_MS);
  });
});

describe("chatCompleteWithAdaptiveMaintenanceRetry thinking downgrade", () => {
  beforeEach(() => {
    vi.spyOn(chat, "chatCompleteWithRetryDetailed");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries with thinking=disabled after adaptive timeout on primary model", async () => {
    const timeoutErr = new Error("LLM request timeout after 180000ms (model: MiniMax-M3)");
    vi.mocked(chat.chatCompleteWithRetryDetailed)
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce({
        content: "PATTERN: ok\nPATTERN: two",
        modelUsed: "MiniMax-M3",
        attemptChain: ["MiniMax-M3"],
        finishReason: "stop",
      });

    const openai = {} as import("openai").default;
    const detail = await chatCompleteWithAdaptiveMaintenanceRetry({
      model: "MiniMax-M3",
      content: "facts",
      temperature: 0.3,
      maxTokens: 1500,
      openai,
      fallbackModels: ["MiniMax-M2.7-highspeed"],
      label: "test: reflection",
      feature: "reflection",
      logger: {},
      enabled: false,
      thinkingMode: "adaptive",
    });

    expect(detail.content).toContain("PATTERN:");
    expect(chat.chatCompleteWithRetryDetailed).toHaveBeenCalledTimes(2);
    expect(chat.chatCompleteWithRetryDetailed.mock.calls[0][0].thinkingMode).toBe("adaptive");
    expect(chat.chatCompleteWithRetryDetailed.mock.calls[1][0].thinkingMode).toBe("disabled");
  });
});
