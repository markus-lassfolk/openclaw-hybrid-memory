import { describe, expect, it } from "vitest";
import {
  buildCompactionWatchdogAlert,
  resolveCompactionHookModelMetadata,
} from "../utils/compaction-model-watchdog.js";

describe("compaction hook watchdog metadata", () => {
  it("extracts provider/model from compaction hook metadata and builds an alert with reason", () => {
    const metadata = resolveCompactionHookModelMetadata({
      metadata: {
        compaction: {
          provider: "azure-foundry",
          model: "azure-foundry/gpt-5.5",
        },
      },
    });

    expect(metadata).toEqual({
      provider: "azure-foundry",
      model: "azure-foundry/gpt-5.5",
      source: "event.metadata.compaction.model",
    });

    const alert = buildCompactionWatchdogAlert({
      stage: "before_compaction",
      provider: metadata?.provider,
      model: metadata?.model ?? "",
      source: metadata?.source,
    });

    expect(alert).toContain("provider=azure-foundry");
    expect(alert).toContain("model=azure-foundry/gpt-5.5");
    expect(alert).toContain("reason=");
    expect(alert).toContain("source=event.metadata.compaction.model");
  });

  it("handles missing model metadata safely", () => {
    const metadata = resolveCompactionHookModelMetadata({
      messageCount: 23,
      tokenCount: 4000,
      metadata: { stage: "before_compaction" },
    });
    expect(metadata).toBeNull();
  });

  it("does not emit alerts for MiniMax M2.7-highspeed or mini/nano models", () => {
    const minimaxAlert = buildCompactionWatchdogAlert({
      stage: "after_compaction",
      model: "minimax/MiniMax-M2.7-highspeed",
      provider: "minimax",
      source: "event.compaction.model",
    });
    const miniAlert = buildCompactionWatchdogAlert({
      stage: "after_compaction",
      model: "openai/gpt-4.1-mini",
      provider: "openai",
      source: "event.compaction.model",
    });

    expect(minimaxAlert).toBeNull();
    expect(miniAlert).toBeNull();
  });
});
