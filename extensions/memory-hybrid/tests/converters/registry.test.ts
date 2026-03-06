import { describe, it, expect } from "vitest";
import { getConverter, registerConverter, type Converter } from "../../tools/converters/index.js";

describe("converter registry", () => {
  it("returns null for unknown file extensions", () => {
    expect(getConverter("/path/to/file.docx", "some content")).toBeNull();
    expect(getConverter("/path/to/file.pdf", "some content")).toBeNull();
    expect(getConverter("/path/to/file.txt", "some content")).toBeNull();
  });

  it("returns null for YAML with no content hint", () => {
    // No content => cannot sniff
    expect(getConverter("/path/to/config.yaml")).toBeNull();
  });

  it("returns HA converter for HA-specific YAML content", () => {
    const haContent = "automation:\n  - alias: Test\n    trigger: []\n    action: []";
    const converter = getConverter("/path/config.yaml", haContent);
    expect(converter).not.toBeNull();
    const result = converter!.convert(haContent, "/path/config.yaml");
    expect(result.metadata["source"]).toBe("ha-yaml-converter");
  });

  it("returns ESPHome converter for ESPHome YAML content", () => {
    const esphomeContent = "esphome:\n  name: test\nesp32:\n  board: esp32dev";
    const converter = getConverter("/path/device.yaml", esphomeContent);
    expect(converter).not.toBeNull();
    const result = converter!.convert(esphomeContent, "/path/device.yaml");
    expect(result.metadata["source"]).toBe("esphome-yaml-converter");
  });

  it("returns ESPHome converter for esp8266 YAML", () => {
    const content = "esp8266:\n  board: d1_mini\nesphome:\n  name: wemos";
    const converter = getConverter("/path/wemos.yaml", content);
    expect(converter).not.toBeNull();
    const result = converter!.convert(content, "/path/wemos.yaml");
    expect(result.metadata["source"]).toBe("esphome-yaml-converter");
  });

  it("returns Zigbee2MQTT converter for configuration.yaml with mqtt+serial", () => {
    const z2mContent = "mqtt:\n  server: mqtt://broker\n  base_topic: z2m\nserial:\n  port: /dev/ttyUSB0";
    const converter = getConverter("/config/configuration.yaml", z2mContent);
    expect(converter).not.toBeNull();
    const result = converter!.convert(z2mContent, "/config/configuration.yaml");
    expect(result.metadata["source"]).toBe("zigbee2mqtt-converter");
  });

  it("does NOT return Zigbee2MQTT for configuration.yaml without serial:", () => {
    // HA config named configuration.yaml should not match Z2M
    const haContent = "homeassistant:\n  name: My Home\nautomation: []";
    const converter = getConverter("/config/configuration.yaml", haContent);
    // Should match HA converter, not Z2M
    if (converter) {
      const result = converter.convert(haContent, "/config/configuration.yaml");
      expect(result.metadata["source"]).toBe("ha-yaml-converter");
    }
  });

  it("returns Victron converter for .csv extension", () => {
    const csvContent = "Timestamp,Battery Voltage (V),SOC (%)\n2024-01-01,48.5,80";
    const converter = getConverter("/exports/data.csv", csvContent);
    expect(converter).not.toBeNull();
    const result = converter!.convert(csvContent, "/exports/data.csv");
    expect(result.metadata["source"]).toBe("victron-vrm-converter");
  });

  it("returns Victron converter for .json with Victron data", () => {
    const jsonContent = JSON.stringify({ records: [{ soc: 80, pv_power: 1000 }] });
    const converter = getConverter("/exports/victron.json", jsonContent);
    expect(converter).not.toBeNull();
    const result = converter!.convert(jsonContent, "/exports/victron.json");
    expect(result.metadata["source"]).toBe("victron-vrm-converter");
  });

  it("returns Zigbee2MQTT converter for .json device database", () => {
    const jsonContent = JSON.stringify({
      "0x00158d0003012345": {
        friendly_name: "Living Room PIR",
        model: "RTCGQ11LM",
        manufacturer: "Aqara",
      },
      "0x000b57fffec6a1b2": {
        friendly_name: "Garden Light",
        model: "GL-C-008",
      },
    });
    const converter = getConverter("/config/devices.json", jsonContent);
    expect(converter).not.toBeNull();
    const result = converter!.convert(jsonContent, "/config/devices.json");
    expect(result.metadata["source"]).toBe("zigbee2mqtt-converter");
  });

  it("supports registering custom converters", () => {
    const customConverter: Converter = {
      extensions: [".testfmt"],
      convert: (content, filePath) => ({
        markdown: `# Custom: ${filePath}\n\n${content}`,
        title: `Custom: ${filePath}`,
        metadata: { source: "custom-test-converter" },
      }),
    };

    registerConverter(customConverter);

    const converter = getConverter("/path/to/file.testfmt", "hello");
    expect(converter).not.toBeNull();
    const result = converter!.convert("hello", "/path/to/file.testfmt");
    expect(result.metadata["source"]).toBe("custom-test-converter");
  });

  it("handles .yml extension same as .yaml", () => {
    const esphomeContent = "esphome:\n  name: device\nesp32:\n  board: esp32dev";
    const converter = getConverter("/path/device.yml", esphomeContent);
    expect(converter).not.toBeNull();
    const result = converter!.convert(esphomeContent, "/path/device.yml");
    expect(result.metadata["source"]).toBe("esphome-yaml-converter");
  });
});
