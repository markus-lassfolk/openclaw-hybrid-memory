import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSHOP_MAX_PENDING,
  isWorkshopEnabled,
  MISSION_CONTROL_SESSION_KEY,
  resolveWorkshopMaxPending,
  resolveWorkshopSessionKey,
} from "../services/workshop-config.js";

describe("workshop-config", () => {
  it("isWorkshopEnabled respects explicit workshop.enabled", () => {
    expect(isWorkshopEnabled({ workshop: { enabled: false } } as never)).toBe(false);
    expect(isWorkshopEnabled({ workshop: { enabled: true } } as never)).toBe(true);
  });

  it("isWorkshopEnabled auto-detects active proposal sources", () => {
    expect(isWorkshopEnabled({ personaProposals: { enabled: true } } as never)).toBe(true);
    expect(isWorkshopEnabled({ crystallization: { enabled: true } } as never)).toBe(true);
    expect(isWorkshopEnabled({ procedures: { enabled: false } } as never)).toBe(false);
  });

  it("resolveWorkshopMaxPending prefers workshop.maxPending", () => {
    expect(resolveWorkshopMaxPending({ workshop: { maxPending: 12 } } as never)).toBe(12);
    expect(resolveWorkshopMaxPending({ personaProposals: { workshopMaxPending: 25 } } as never)).toBe(25);
    expect(resolveWorkshopMaxPending(undefined)).toBe(DEFAULT_WORKSHOP_MAX_PENDING);
  });

  it("resolveWorkshopSessionKey defaults to mission-control", () => {
    expect(resolveWorkshopSessionKey(undefined)).toBe(MISSION_CONTROL_SESSION_KEY);
    expect(resolveWorkshopSessionKey({ workshop: { sessionKey: "ops-desk" } } as never)).toBe("ops-desk");
  });
});
