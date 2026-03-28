import { describe, it, expect } from "vitest";
import { versionInfo } from "../versionInfo.js";

describe("versionInfo", () => {
  it("exports pluginVersion matching package.json", () => {
    expect(typeof versionInfo.pluginVersion).toBe("string");
    expect(versionInfo.pluginVersion.length).toBeGreaterThan(0);
    expect(versionInfo.pluginVersion).toMatch(/^\d{4}\.\d+\.\d+$/);
  });

  it("exports memoryManagerVersion as 3.0", () => {
    expect(versionInfo.memoryManagerVersion).toBe("3.0");
  });

  it("exports schemaVersion as 3", () => {
    expect(versionInfo.schemaVersion).toBe(3);
  });

  it("is a readonly object with expected shape", () => {
    expect(versionInfo).toHaveProperty("pluginVersion");
    expect(versionInfo).toHaveProperty("memoryManagerVersion");
    expect(versionInfo).toHaveProperty("schemaVersion");
  });
});
