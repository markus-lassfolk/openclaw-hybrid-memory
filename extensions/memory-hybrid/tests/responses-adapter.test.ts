import { describe, expect, it, vi } from "vitest";
import {
  buildResponsesRequestBody,
  callResponsesApi,
  extractResponsesText,
  extractResponsesUsage,
} from "../services/responses-adapter.js";

describe("buildResponsesRequestBody", () => {
  it("builds minimal request body from content", () => {
    const body = buildResponsesRequestBody({
      model: "o3-pro",
      content: "Hello world",
    });
    expect(body).toEqual({
      model: "o3-pro",
      input: [{ role: "user", content: "Hello world" }],
      stream: false,
    });
  });

  it("includes max_output_tokens when maxTokens is provided", () => {
    const body = buildResponsesRequestBody({
      model: "o3-pro",
      content: "test",
      maxTokens: 4000,
    });
    expect(body.max_output_tokens).toBe(4000);
  });

  it("includes temperature for non-reasoning models", () => {
    const body = buildResponsesRequestBody({
      model: "gpt-5.4-pro",
      content: "test",
      temperature: 0.5,
    });
    expect(body.temperature).toBe(0.5);
  });

  it("strips temperature for reasoning models (o3-pro)", () => {
    const body = buildResponsesRequestBody({
      model: "o3-pro",
      content: "test",
      temperature: 0.5,
    });
    expect(body.temperature).toBeUndefined();
  });
});

describe("extractResponsesText", () => {
  it("extracts text from a standard Responses API output", () => {
    const response = {
      id: "resp_123",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "  Hello from Responses API  " }],
        },
      ],
    };
    expect(extractResponsesText(response as any)).toBe("Hello from Responses API");
  });

  it("returns empty string when no text output items exist", () => {
    const response = {
      id: "resp_123",
      output: [{ type: "reasoning", summary: [{ type: "text", text: "thinking..." }] }],
    };
    expect(extractResponsesText(response as any)).toBe("");
  });

  it("returns empty string for empty output array", () => {
    expect(extractResponsesText({ id: "resp_123", output: [] })).toBe("");
  });

  it("handles multiple output items, takes first text", () => {
    const response = {
      id: "resp_123",
      output: [
        { type: "reasoning", summary: [] },
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "" },
            { type: "output_text", text: "actual text" },
          ],
        },
      ],
    };
    expect(extractResponsesText(response as any)).toBe("actual text");
  });
});

describe("extractResponsesUsage", () => {
  it("maps input_tokens/output_tokens to prompt_tokens/completion_tokens", () => {
    const response = {
      id: "resp_123",
      output: [],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    };
    expect(extractResponsesUsage(response)).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
    });
  });

  it("returns undefined when usage is absent", () => {
    expect(extractResponsesUsage({ id: "resp_123", output: [] })).toBeUndefined();
  });

  it("defaults missing token fields to 0", () => {
    const response = {
      id: "resp_123",
      output: [],
      usage: {},
    };
    expect(extractResponsesUsage(response as any)).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
    });
  });
});

describe("callResponsesApi", () => {
  it("calls client.responses.create and returns extracted text", async () => {
    const mockClient = {
      responses: {
        create: vi.fn().mockResolvedValue({
          id: "resp_123",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "OK" }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      },
    };

    const { text, raw } = await callResponsesApi(mockClient as any, {
      model: "o3-pro",
      content: "Reply with: OK",
      maxTokens: 10,
    });

    expect(text).toBe("OK");
    expect(raw.id).toBe("resp_123");
    expect(mockClient.responses.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "o3-pro",
        input: [{ role: "user", content: "Reply with: OK" }],
        stream: false,
        max_output_tokens: 10,
      }),
      {},
    );
  });

  it("throws when client.responses is not available", async () => {
    const mockClient = {} as any;

    await expect(callResponsesApi(mockClient, { model: "o3-pro", content: "test" })).rejects.toThrow(
      "does not expose responses.create()",
    );
  });

  it("passes signal through to the create call", async () => {
    const controller = new AbortController();
    const mockClient = {
      responses: {
        create: vi.fn().mockResolvedValue({
          id: "resp_123",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "OK" }],
            },
          ],
        }),
      },
    };

    await callResponsesApi(mockClient as any, { model: "o3-pro", content: "test" }, { signal: controller.signal });

    expect(mockClient.responses.create).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal });
  });
});
