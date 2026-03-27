import { describe, expect, it } from "vitest";
import { esphomeYamlConverter } from "../../tools/converters/esphome-yaml-converter.js";
import { haYamlConverter } from "../../tools/converters/ha-yaml-converter.js";

describe("yaml-converter bugfixes", () => {
  describe("Bug 2: Preprocessor should not corrupt quoted strings", () => {
    it("HA converter preserves quoted strings containing tag-like text in automation descriptions", () => {
      const yaml = `automation:
  - alias: "Security Check"
    description: "Do not use !secret wifi_pass in production"
    trigger:
      - platform: time
        at: "09:00:00"
    action:
      - service: notify.mobile_app`;

      const result = haYamlConverter.convert(yaml, "test.yaml");

      // The markdown should contain the original quoted string in the description
      expect(result.markdown).toContain("Do not use !secret wifi_pass in production");

      // Should NOT contain the sentinel prefixes
      expect(result.markdown).not.toContain("__HA_SECRET__");
      expect(result.markdown).not.toContain("__HA_INCLUDE__");
    });

    it("HA converter still handles actual tags correctly", () => {
      const yaml = `homeassistant:
  name: !secret home_name

automation: !include automations.yaml
sensor: !include_dir_list sensors/`;

      const result = haYamlConverter.convert(yaml, "config.yaml");

      // Should show references to the actual tags
      expect(result.markdown).toContain("*(secret: home_name)*");
      expect(result.markdown).toContain("automations.yaml");
      expect(result.markdown).toContain("## Referenced Files");
    });

    it("ESPHome converter preserves quoted strings containing !secret in sensor names", () => {
      const yaml = `esphome:
  name: test_device

esp32:
  board: esp32dev

sensor:
  - platform: template
    name: "Warning: !secret not for display"`;

      const result = esphomeYamlConverter.convert(yaml, "device.yaml");

      // The markdown should contain the original quoted string
      expect(result.markdown).toContain("Warning: !secret not for display");

      // Should NOT have [REDACTED] for quoted strings
      expect(result.markdown).not.toContain("[REDACTED]");
    });

    it("ESPHome converter still redacts actual !secret tags", () => {
      const yaml = `esphome:
  name: test_device

wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password`;

      const result = esphomeYamlConverter.convert(yaml, "device.yaml");

      // Should contain [REDACTED] for actual secrets
      expect(result.markdown).toContain("[REDACTED]");

      // Should NOT contain the actual secret names
      expect(result.markdown).not.toContain("wifi_ssid");
      expect(result.markdown).not.toContain("wifi_password");
    });

    it("handles edge case: tag-like text in automation alias", () => {
      const yaml = `automation:
  - alias: "This ends with !secret"
    trigger:
      - platform: state
        entity_id: sensor.test
    action:
      - service: notify.send`;

      const result = haYamlConverter.convert(yaml, "test.yaml");

      expect(result.markdown).toContain("This ends with !secret");
      expect(result.markdown).not.toContain("__HA_SECRET__");
    });
  });
});
