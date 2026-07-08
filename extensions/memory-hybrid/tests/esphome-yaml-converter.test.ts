/**
 * Regression tests (loop iteration 86) for tools/converters/esphome-yaml-converter.ts:
 *
 * A bare `api:` / `ota:` key with no sub-options YAML-parses to `null`, and in ESPHome's config
 * format that means the component IS enabled (with default settings) — the component's mere
 * presence as a top-level key is what turns it on; there's no standard way to write "present but
 * disabled" other than omitting the key entirely. The converter's `apiEnabled`/`otaEnabled`
 * checks treated `null` the same as `false`, inverting the most common real-world case where a
 * config simply writes `api:`/`ota:` alone to enable the component.
 */
import { describe, expect, it } from "vitest";
import { esphomeYamlConverter } from "../tools/converters/esphome-yaml-converter.js";

describe("esphomeYamlConverter — API/OTA enabled detection (loop iteration 86 regression)", () => {
  it("reports Enabled: true for a bare `api:` key with no sub-options", () => {
    const yaml = ["esphome:", "  name: livingroom-sensor", "api:", "ota:", ""].join("\n");

    const result = esphomeYamlConverter.convert(yaml, "device.yaml");

    expect(result.markdown).toContain("## API\n\n- Enabled: true");
    expect(result.markdown).toContain("## OTA\n\n- Enabled: true");
  });

  it("reports Enabled: true for `api:`/`ota:` with sub-options configured", () => {
    const yaml = [
      "esphome:",
      "  name: livingroom-sensor",
      "api:",
      "  encryption:",
      '    key: "[REDACTED]"',
      "ota:",
      "  platform: esphome",
      "",
    ].join("\n");

    const result = esphomeYamlConverter.convert(yaml, "device.yaml");

    expect(result.markdown).toContain("## API\n\n- Enabled: true");
    expect(result.markdown).toContain("## OTA\n\n- Enabled: true");
  });

  it("reports Enabled: false for an explicit `api: false` / `ota: false`", () => {
    const yaml = ["esphome:", "  name: livingroom-sensor", "api: false", "ota: false", ""].join("\n");

    const result = esphomeYamlConverter.convert(yaml, "device.yaml");

    expect(result.markdown).toContain("## API\n\n- Enabled: false");
    expect(result.markdown).toContain("## OTA\n\n- Enabled: false");
  });

  it("omits the API/OTA sections entirely when the keys are absent", () => {
    const yaml = ["esphome:", "  name: livingroom-sensor", ""].join("\n");

    const result = esphomeYamlConverter.convert(yaml, "device.yaml");

    expect(result.markdown).not.toContain("## API");
    expect(result.markdown).not.toContain("## OTA");
  });
});
