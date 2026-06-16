import { beforeEach, describe, expect, it } from "vitest";
import {
  _getNudgeTrackedSessionCountForTests,
  recordNudgeEmission,
  resetNudgeState,
} from "../services/memory-nudge.js";

describe("memory-nudge session eviction", () => {
  beforeEach(() => resetNudgeState());

  it("bounds sessionLastActivity when nudges emit without suppress entries", () => {
    for (let i = 0; i < 250; i++) {
      recordNudgeEmission(`session-${i}`);
    }
    expect(_getNudgeTrackedSessionCountForTests()).toBeLessThanOrEqual(201);
  });
});
