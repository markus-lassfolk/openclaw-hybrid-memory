import { describe, it, expect } from "vitest";
import { zigbee2mqttConverter } from "../../tools/converters/zigbee2mqtt-converter.js";

describe("zigbee2mqttConverter (configuration.yaml)", () => {
  it("parses a full Zigbee2MQTT config", () => {
    const yaml = `
mqtt:
  server: mqtt://192.168.1.10:1883
  base_topic: zigbee2mqtt
  user: z2m_user
  password: "secret_mqtt_password"

serial:
  port: /dev/ttyUSB0
  adapter: deconz

advanced:
  pan_id: 0x1a62
  channel: 15
  network_key: [1, 3, 5, 7, 9, 11, 13, 15, 0, 2, 4, 6, 8, 10, 12, 13]

homeassistant: true

devices:
  "0x00158d0003012345":
    friendly_name: "Living Room Motion"
    model: "RTCGQ11LM"
    manufacturer: "Aqara"

  "0x00158d000301abcd":
    friendly_name: "Kitchen Switch"
    model: "WXKG11LM"

groups:
  "1":
    friendly_name: "All Lights"
    members:
      - ieee_address: "0x00158d0003012345"
      - ieee_address: "0x00158d000301abcd"
`.trim();

    const result = zigbee2mqttConverter.convert(yaml, "/config/configuration.yaml");
    expect(result.title).toBe("Zigbee2MQTT Configuration");
    expect(result.markdown).toContain("## MQTT");
    expect(result.markdown).toContain("192.168.1.10:1883");
    expect(result.markdown).toContain("zigbee2mqtt");
    expect(result.markdown).toContain("## Serial");
    expect(result.markdown).toContain("/dev/ttyUSB0");
    expect(result.markdown).toContain("## Devices");
    expect(result.markdown).toContain("Living Room Motion");
    expect(result.markdown).toContain("Kitchen Switch");
    expect(result.markdown).toContain("## Groups");
    expect(result.markdown).toContain("All Lights");
    expect(result.markdown).toContain("## Home Assistant Integration");
    expect(result.metadata["deviceCount"]).toBe(2);
    expect(result.metadata["groupCount"]).toBe(1);
  });

  it("SECURITY: strips MQTT password from output", () => {
    const yaml = `
mqtt:
  server: mqtt://broker.local:1883
  base_topic: z2m
  password: "super_secret_broker_password"

serial:
  port: /dev/ttyACM0
`.trim();

    const result = zigbee2mqttConverter.convert(yaml, "/config/configuration.yaml");
    expect(result.markdown).not.toContain("super_secret_broker_password");
    expect(result.markdown).toContain("[REDACTED]");
    expect(result.markdown).toContain("mqtt://broker.local:1883");
  });

  it("SECURITY: strips network_key from advanced section", () => {
    const yaml = `
mqtt:
  server: mqtt://broker.local
  base_topic: z2m

serial:
  port: /dev/ttyUSB0

advanced:
  network_key: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
  channel: 11
`.trim();

    const result = zigbee2mqttConverter.convert(yaml, "/config/configuration.yaml");
    // The raw key array should not appear
    expect(result.markdown).not.toMatch(/1, 2, 3, 4, 5, 6/);
    expect(result.markdown).toContain("[REDACTED]");
    expect(result.markdown).toContain("Channel: 11");
  });

  it("handles minimal config (mqtt + serial only)", () => {
    const yaml = `
mqtt:
  server: mqtt://localhost
  base_topic: zigbee2mqtt

serial:
  port: /dev/ttyUSB0
`.trim();

    const result = zigbee2mqttConverter.convert(yaml, "/config/configuration.yaml");
    expect(result.title).toBe("Zigbee2MQTT Configuration");
    expect(result.markdown).toContain("mqtt://localhost");
    expect(result.metadata["deviceCount"]).toBe(0);
  });

  it("handles disabled devices", () => {
    const yaml = `
mqtt:
  server: mqtt://broker
  base_topic: z2m

serial:
  port: /dev/ttyUSB0

devices:
  "0xaabbccdd00112233":
    friendly_name: "Old Sensor"
    disabled: true
`.trim();

    const result = zigbee2mqttConverter.convert(yaml, "/config/configuration.yaml");
    expect(result.markdown).toContain("DISABLED");
    expect(result.markdown).toContain("Old Sensor");
  });

  it("handles empty/invalid YAML gracefully", () => {
    const result = zigbee2mqttConverter.convert("", "/config/configuration.yaml");
    expect(result.title).toBe("Zigbee2MQTT Configuration");
    // Should not throw
  });
});

describe("zigbee2mqttConverter (device database JSON)", () => {
  it("parses a device database JSON file", () => {
    const json = JSON.stringify({
      "0x00158d0003012345": {
        friendly_name: "Living Room PIR",
        ieee_address: "0x00158d0003012345",
        model: "RTCGQ11LM",
        manufacturer: "Aqara",
        description: "Motion sensor",
      },
      "0x000b57fffec6a1b2": {
        friendly_name: "Garden Light",
        ieee_address: "0x000b57fffec6a1b2",
        model: "GL-C-008",
        manufacturer: "Gledopto",
      },
    });

    const result = zigbee2mqttConverter.convert(json, "/config/devices.json");
    expect(result.title).toContain("devices.json");
    expect(result.markdown).toContain("## Devices");
    expect(result.markdown).toContain("Living Room PIR");
    expect(result.markdown).toContain("Garden Light");
    expect(result.markdown).toContain("Aqara");
    expect(result.markdown).toContain("Gledopto");
    expect(result.metadata["deviceCount"]).toBe(2);
    expect(result.metadata["type"]).toBe("device-database");
  });

  it("handles malformed JSON gracefully", () => {
    const result = zigbee2mqttConverter.convert("{not valid", "/config/devices.json");
    expect(result.markdown).toContain("Could not parse JSON");
  });

  it("handles empty device database", () => {
    const json = JSON.stringify({});
    const result = zigbee2mqttConverter.convert(json, "/config/empty_devices.json");
    expect(result.markdown).toContain("No devices found");
    expect(result.metadata["deviceCount"]).toBe(0);
  });
});
