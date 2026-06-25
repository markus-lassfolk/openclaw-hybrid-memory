import { afterEach, describe, expect, it } from "vitest";
import {
  capTimeoutByMaintenanceRunDeadline,
  clearMaintenanceRunDeadline,
  getMaintenanceRunDeadlineMs,
  maintenanceRunDeadlineReached,
  remainingMaintenanceRunMs,
  resolveMaintenanceStepDeadlineMs,
  setMaintenanceRunDeadlineMs,
} from "../utils/maintenance-run-deadline.js";

describe("maintenance-run-deadline", () => {
  afterEach(() => {
    clearMaintenanceRunDeadline();
  });

  it("tracks orchestrator deadline via env", () => {
    setMaintenanceRunDeadlineMs(10_000);
    expect(getMaintenanceRunDeadlineMs()).toBe(10_000);
    expect(maintenanceRunDeadlineReached(9_999)).toBe(false);
    expect(maintenanceRunDeadlineReached(10_000)).toBe(true);
    expect(remainingMaintenanceRunMs(9_000)).toBe(1_000);
  });

  it("resolveMaintenanceStepDeadlineMs picks earliest deadline", () => {
    setMaintenanceRunDeadlineMs(50_000);
    expect(resolveMaintenanceStepDeadlineMs(40_000, 30)).toBe(50_000);
    expect(resolveMaintenanceStepDeadlineMs(40_000, 120)).toBe(50_000);
    clearMaintenanceRunDeadline();
    expect(resolveMaintenanceStepDeadlineMs(40_000, 30)).toBe(70_000);
  });

  it("capTimeoutByMaintenanceRunDeadline shrinks per-call timeout near run end", () => {
    setMaintenanceRunDeadlineMs(10_000);
    expect(capTimeoutByMaintenanceRunDeadline(45_000, 9_000)).toBe(1_000);
    expect(capTimeoutByMaintenanceRunDeadline(45_000, 10_000)).toBe(0);
  });
});
