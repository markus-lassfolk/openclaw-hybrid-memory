import { describe, expect, it } from "vitest";
import {
  getAutoCaptureExtractionConfidence,
  getAutoCaptureExtractionMethod,
  resolveCaptureProvenance,
} from "../services/capture-provenance.js";

describe("resolveCaptureProvenance", () => {
  it("allows interactive chat sessions", () => {
    const result = resolveCaptureProvenance(
      { messages: [{ role: "user", content: "Remember I prefer dark mode." }] },
      { context: { sessionId: "sess-1", messageChannel: "chat" } },
      "sess-1",
    );

    expect(result.origin).toBe("interactive");
    expect(result.shouldAutoCapture).toBe(true);
    expect(result.sessionId).toBe("sess-1");
  });

  it("blocks system-channel cron sessions", () => {
    const result = resolveCaptureProvenance(
      {
        prompt: "Nightly memory maintenance. Run in order: openclaw hybrid-mem prune",
        messages: [{ role: "user", content: "Nightly memory maintenance. Run in order: openclaw hybrid-mem prune" }],
      },
      { context: { sessionId: "cron-1", messageChannel: "system" } },
      "cron-1",
    );

    expect(result.origin).toBe("cron");
    expect(result.shouldAutoCapture).toBe(false);
    expect(result.reason).toContain("cron");
  });

  it("blocks system sessions even when no cron prompt is present", () => {
    const result = resolveCaptureProvenance(
      { messages: [{ role: "user", content: "Internal automation status report" }] },
      { context: { sessionId: "sys-1", messageChannel: "system" } },
      "sys-1",
    );

    expect(result.origin).toBe("system");
    expect(result.shouldAutoCapture).toBe(false);
    expect(result.reason).toContain("system");
  });
});

describe("auto-capture provenance metadata helpers", () => {
  it("encodes extraction method with role and origin", () => {
    expect(getAutoCaptureExtractionMethod("user", { origin: "interactive" })).toBe("auto-capture:user:interactive");
    expect(getAutoCaptureExtractionMethod("assistant", { origin: "cron" })).toBe("auto-capture:assistant:cron");
  });

  it("assigns higher confidence to direct user text", () => {
    expect(getAutoCaptureExtractionConfidence("user")).toBe(1);
    expect(getAutoCaptureExtractionConfidence("assistant")).toBe(0.7);
  });
});
