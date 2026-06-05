import { describe, expect, it } from "vitest";
import { parseWorkshopConfig } from "../config/parsers/features.js";
import {
  DEFAULT_WORKSHOP_MAX_PENDING,
  isWorkshopEnabled,
  listWorkshopDashboardChangeFeedSessions,
  MISSION_CONTROL_SESSION_KEY,
  resolveWorkshopAppliedSessionKey,
  resolveWorkshopMaxPending,
  resolveWorkshopProposedSessionKey,
  resolveWorkshopRevertSessionKey,
  resolveWorkshopSessionKey,
} from "../services/workshop-config.js";
import { BROADCAST_CHANGE_SESSION_KEY } from "../services/change-feed-emit.js";

describe("workshop-config", () => {
  it("isWorkshopEnabled respects explicit workshop.enabled", () => {
    expect(isWorkshopEnabled({ workshop: { enabled: false } } as never)).toBe(false);
    expect(isWorkshopEnabled({ workshop: { enabled: true } } as never)).toBe(true);
  });

  it("isWorkshopEnabled auto-detects active proposal sources", () => {
    expect(isWorkshopEnabled({ personaProposals: { enabled: true } } as never)).toBe(true);
    expect(isWorkshopEnabled({ crystallization: { enabled: true } } as never)).toBe(true);
    expect(isWorkshopEnabled({ selfExtension: { enabled: true } } as never)).toBe(true);
    expect(isWorkshopEnabled({ procedures: { enabled: true } } as never)).toBe(true);
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

  it("resolveWorkshopProposedSessionKey uses broadcast", () => {
    expect(resolveWorkshopProposedSessionKey()).toBe(BROADCAST_CHANGE_SESSION_KEY);
  });

  it("resolveWorkshopAppliedSessionKey uses workshop session key", () => {
    expect(resolveWorkshopAppliedSessionKey(undefined)).toBe(MISSION_CONTROL_SESSION_KEY);
    expect(resolveWorkshopAppliedSessionKey({ workshop: { sessionKey: "ops-desk" } } as never)).toBe("ops-desk");
  });

  it("listWorkshopDashboardChangeFeedSessions includes broadcast and workshop session", () => {
    const sessions = listWorkshopDashboardChangeFeedSessions({ workshop: { sessionKey: "ops-desk" } } as never);
    expect(sessions).toContain(BROADCAST_CHANGE_SESSION_KEY);
    expect(sessions).toContain("ops-desk");
    expect(sessions).toHaveLength(2);
  });

  it("resolveWorkshopRevertSessionKey prefers explicit then chat then workshop default", () => {
    const cfg = { workshop: { sessionKey: "mission-control" } } as never;
    expect(resolveWorkshopRevertSessionKey(cfg, "explicit")).toBe("explicit");
    expect(resolveWorkshopRevertSessionKey(cfg, undefined, "chat-1")).toBe("chat-1");
    expect(resolveWorkshopRevertSessionKey(cfg)).toBe(MISSION_CONTROL_SESSION_KEY);
  });
});

describe("parseWorkshopConfig", () => {
  it("parses enabled, maxPending, and sessionKey", () => {
    expect(
      parseWorkshopConfig({
        workshop: { enabled: true, maxPending: 40, sessionKey: "  ops-desk  " },
      }),
    ).toEqual({ enabled: true, maxPending: 40, sessionKey: "ops-desk" });
  });

  it("returns undefined when workshop block is absent or empty", () => {
    expect(parseWorkshopConfig({})).toBeUndefined();
    expect(parseWorkshopConfig({ workshop: {} })).toBeUndefined();
  });
});
