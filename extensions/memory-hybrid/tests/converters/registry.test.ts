// @ts-nocheck
import { describe, expect, it } from "vitest";
import { type Converter, getConverter, registerConverter } from "../../tools/converters/index.js";

describe("converter registry", () => {
  it("returns null for unknown file extensions", () => {
    expect(getConverter("/path/to/file.docx", "some content")).toBeNull();
    expect(getConverter("/path/to/file.pdf", "some content")).toBeNull();
    expect(getConverter("/path/to/file.txt", "some content")).toBeNull();
  });

  it("returns null for YAML with no content hint", () => {
    expect(getConverter("/path/to/config.yaml")).toBeNull();
  });

  it("returns null for HA-style YAML when no converters registered (domain converters removed from builtin)", () => {
    const haContent = "automation:\n  - alias: Test\n    trigger: []\n    action: []";
    expect(getConverter("/path/config.yaml", haContent)).toBeNull();
  });

  it("returns null for ESPHome YAML when no converters registered", () => {
    const esphomeContent = "esphome:\n  name: test\nesp32:\n  board: esp32dev";
    expect(getConverter("/path/device.yaml", esphomeContent)).toBeNull();
  });

  it("returns null for Zigbee2MQTT-style YAML when no converters registered", () => {
    const z2mContent = "mqtt:\n  server: mqtt://broker\nserial:\n  port: /dev/ttyUSB0";
    expect(getConverter("/config/configuration.yaml", z2mContent)).toBeNull();
  });

  it("returns null for Victron .csv when no converters registered", () => {
    const csvContent = "Timestamp,Battery Voltage (V),SOC (%)\n2024-01-01,48.5,80";
    expect(getConverter("/exports/data.csv", csvContent)).toBeNull();
  });

  it("returns null for Victron .json when no converters registered", () => {
    const jsonContent = JSON.stringify({ records: [{ soc: 80, pv_power: 1000 }] });
    expect(getConverter("/exports/victron.json", jsonContent)).toBeNull();
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
    const result = converter?.convert("hello", "/path/to/file.testfmt");
    expect(result.metadata.source).toBe("custom-test-converter");
  });

  it("returns registered YAML converter when one is registered", () => {
    const yamlConverter: Converter = {
      extensions: [".yaml", ".yml"],
      convert: (content, filePath) => ({
        markdown: content,
        title: filePath,
        metadata: { source: "registered-yaml" },
      }),
    };
    registerConverter(yamlConverter);
    const converter = getConverter("/path/device.yml", "esphome:\n  name: x");
    expect(converter).not.toBeNull();
    expect(converter?.convert("", "").metadata.source).toBe("registered-yaml");
  });
});
