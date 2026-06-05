import { describe, expect, it } from "vitest";
import { shouldPinFactForInjection } from "../services/pinned-recall-policy.js";

describe("shouldPinFactForInjection", () => {
  const nowSec = 1_700_000_000;

  it("pins permanent facts", () => {
    expect(shouldPinFactForInjection({ decayClass: "permanent" }, 3, nowSec)).toBe(true);
  });

  it("rejects high recall_count without recent access (#1559)", () => {
    expect(
      shouldPinFactForInjection(
        {
          decayClass: "stable",
          recallCount: 10,
          indexedCount: 0,
          lastAccessed: nowSec - 20 * 86400,
        },
        3,
        nowSec,
      ),
    ).toBe(false);
  });

  it("rejects index-inflated garbage", () => {
    expect(
      shouldPinFactForInjection(
        {
          decayClass: "stable",
          recallCount: 2,
          indexedCount: 100,
          lastAccessed: nowSec - 3600,
        },
        3,
        nowSec,
      ),
    ).toBe(false);
  });

  it("pins recently accessed high-recall facts", () => {
    expect(
      shouldPinFactForInjection(
        {
          decayClass: "stable",
          recallCount: 5,
          indexedCount: 6,
          lastAccessed: nowSec - 3600,
        },
        3,
        nowSec,
      ),
    ).toBe(true);
  });
});
