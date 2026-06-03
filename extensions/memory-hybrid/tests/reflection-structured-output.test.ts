import { describe, expect, it } from "vitest";
import {
  classifyZeroMetasReason,
  classifyZeroRulesReason,
  parseMetasFromModelResponse,
  parseRulesFromModelResponse,
} from "../services/reflection/structured-output.js";

describe("parseRulesFromModelResponse (#1801)", () => {
  it("parses rules from JSON object response", () => {
    const res = parseRulesFromModelResponse(
      JSON.stringify({
        rules: ["Always prefer explicit TypeScript types for public APIs"],
        noAction: false,
      }),
    );
    expect(res.parsedFromJson).toBe(true);
    expect(res.rules).toHaveLength(1);
    expect(res.parseSuccess).toBe(true);
  });

  it("accepts JSON noAction when there are no rules", () => {
    const res = parseRulesFromModelResponse(JSON.stringify({ rules: [], noAction: true }));
    expect(res.parsedFromJson).toBe(true);
    expect(res.rules).toHaveLength(0);
    expect(res.looksLikeValidNoRules).toBe(true);
    expect(classifyZeroRulesReason(res, 20)).toBe("valid_no_actionable_rules");
  });

  it("falls back to RULE: line parsing when JSON is absent", () => {
    const res = parseRulesFromModelResponse(
      "RULE: Never commit secrets to version control\nRULE: Prefer small focused functions",
    );
    expect(res.parsedFromJson).toBe(false);
    expect(res.rules).toHaveLength(2);
  });

  it("strips thinking wrappers before JSON parse", () => {
    const res = parseRulesFromModelResponse(
      `<thinking>draft</thinking>${JSON.stringify({ rules: ["Always validate cron exit ledgers"], noAction: false })}`,
    );
    expect(res.parsedFromJson).toBe(true);
    expect(res.rules).toHaveLength(1);
  });

  it("parses JSON inside thinking wrappers", () => {
    const res = parseRulesFromModelResponse(
      `<thinking>${JSON.stringify({ rules: ["Never hardcode credentials in source code"], noAction: false })}</thinking>`,
    );
    expect(res.parsedFromJson).toBe(true);
    expect(res.rules).toHaveLength(1);
    expect(res.rules[0]).toBe("Never hardcode credentials in source code");
  });

  it("classifies prose-only response as invalid_response_format", () => {
    const raw = "Some prose without RULE lines or JSON";
    const res = parseRulesFromModelResponse(raw);
    expect(classifyZeroRulesReason(res, raw.length)).toBe("invalid_response_format");
  });
});

describe("parseMetasFromModelResponse (#1801)", () => {
  it("parses metas from JSON object response", () => {
    const text =
      "User consistently prefers functional composition with strong emphasis on explicit types and small focused modules";
    const res = parseMetasFromModelResponse(JSON.stringify({ metas: [text], noAction: false }));
    expect(res.parsedFromJson).toBe(true);
    expect(res.metas).toEqual([text]);
  });

  it("falls back to META: line parsing", () => {
    const text =
      "User consistently prefers functional composition with strong emphasis on explicit types and small focused modules";
    const res = parseMetasFromModelResponse(`META: ${text}`);
    expect(res.parsedFromJson).toBe(false);
    expect(res.metas).toEqual([text]);
  });

  it("classifies invalid prose as invalid_response_format", () => {
    const res = parseMetasFromModelResponse("Some prose without META lines or JSON");
    expect(classifyZeroMetasReason(res, 40)).toBe("invalid_response_format");
  });

  it("parses JSON inside thinking wrappers", () => {
    const text = "User demonstrates strong preference for immutability and functional patterns across multiple domains";
    const res = parseMetasFromModelResponse(
      `<thinking>${JSON.stringify({ metas: [text], noAction: false })}</thinking>`,
    );
    expect(res.parsedFromJson).toBe(true);
    expect(res.metas).toEqual([text]);
  });
});

describe("classifyZeroMetasReason", () => {
  it("returns valid_no_actionable_metas for JSON noAction", () => {
    const res = parseMetasFromModelResponse(JSON.stringify({ metas: [], noAction: true }));
    expect(classifyZeroMetasReason(res, 18)).toBe("valid_no_actionable_metas");
  });
});
