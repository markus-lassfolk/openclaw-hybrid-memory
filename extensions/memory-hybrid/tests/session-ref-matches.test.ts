/**
 * sessionRefMatches regression matrix (#1486).
 */

import { describe, expect, it } from "vitest";
import { sessionRefMatches } from "../services/pre-finalization-guard.js";
import { FORGE_SUBAGENT_SESSION, MAIN_CANONICAL_SESSION, MAIN_TELEGRAM_SESSION } from "./fixtures/maeve-ledger.js";

describe("sessionRefMatches", () => {
  it("matches agent:main:main checkpoint to agent:main:telegram session (#1486)", () => {
    expect(sessionRefMatches(MAIN_CANONICAL_SESSION, MAIN_TELEGRAM_SESSION)).toBe(true);
    expect(sessionRefMatches(MAIN_TELEGRAM_SESSION, MAIN_CANONICAL_SESSION)).toBe(true);
  });

  it("does not match two different live main channel sessions", () => {
    expect(sessionRefMatches("agent:main:telegram:session-a", "agent:main:telegram:session-b")).toBe(false);
  });

  it("does not match forge subagent session to main telegram session", () => {
    expect(sessionRefMatches(FORGE_SUBAGENT_SESSION, MAIN_TELEGRAM_SESSION)).toBe(false);
  });

  it("matches exact session key equality", () => {
    expect(sessionRefMatches(MAIN_TELEGRAM_SESSION, MAIN_TELEGRAM_SESSION)).toBe(true);
  });

  it("matches bare main alias to agent:main:* session keys", () => {
    expect(sessionRefMatches("main", "agent:main:telegram:abc")).toBe(true);
    expect(sessionRefMatches("agent:main:telegram:abc", "main")).toBe(true);
  });

  it("does not treat empty channel session suffix as a live channel ref (#1505)", () => {
    expect(sessionRefMatches("agent:main:main", "agent:main:telegram:")).toBe(false);
    expect(sessionRefMatches("agent:main:telegram:", "agent:main:main")).toBe(false);
  });
});
