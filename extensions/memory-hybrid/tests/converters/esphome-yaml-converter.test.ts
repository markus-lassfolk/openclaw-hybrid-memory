import { describe, it, expect } from "vitest";
import { esphomeYamlConverter } from "../../tools/converters/esphome-yaml-converter.js";

describe("esphomeYamlConverter", () => {
  it("parses a full ESP32 device config", () => {
    const yaml = `
esphome:
  name: solar_monitor
  friendly_name: "Solar Monitor"

esp32:
  board: esp32dev
  framework:
    type: arduino

wifi:
  ssid: "MyHomeWiFi"
  password: "super_secret_password"
  manual_ip:
    static_ip: 192.168.1.100
    gateway: 192.168.1.1
    subnet: 255.255.255.0

api:
  password: "api_secret"

ota:
  password: "ota_secret"

logger:
  level: DEBUG

sensor:
  - platform: adc
    pin: GPIO34
    name: "Battery Voltage"
    unit_of_measurement: V
    filters:
      - multiply: 3.3

  - platform: dht
    pin: GPIO22
    temperature:
      name: "Temperature"
      unit_of_measurement: "°C"
    humidity:
      name: "Humidity"
      unit_of_measurement: "%"

binary_sensor:
  - platform: gpio
    pin: GPIO12
    name: "Door Sensor"
    device_class: door

switch:
  - platform: gpio
    pin: GPIO16
    name: "Relay 1"
`.trim();

    const result = esphomeYamlConverter.convert(yaml, "/config/solar_monitor.yaml");
    expect(result.title).toBe("ESPHome Device: solar_monitor");
    expect(result.markdown).toContain("## Board");
    expect(result.markdown).toContain("ESP32");
    expect(result.markdown).toContain("esp32dev");
    expect(result.markdown).toContain("## Sensors");
    expect(result.markdown).toContain("Battery Voltage");
    expect(result.markdown).toContain("## Binary Sensors");
    expect(result.markdown).toContain("Door Sensor");
    expect(result.markdown).toContain("## Switches/Outputs");
    expect(result.markdown).toContain("Relay 1");
    expect(result.markdown).toContain("## WiFi");
    expect(result.markdown).toContain("MyHomeWiFi");
    expect(result.markdown).toContain("## API");
    expect(result.markdown).toContain("## OTA");
    expect(result.markdown).toContain("## Logger");
    expect(result.metadata["sensorCount"]).toBe(2);
    expect(result.metadata["binarySensorCount"]).toBe(1);
    expect(result.metadata["switchCount"]).toBe(1);
  });

  it("SECURITY: never includes passwords in output", () => {
    const yaml = `
esphome:
  name: test_device

esp32:
  board: esp32dev

wifi:
  ssid: "TestNetwork"
  password: "very_secret_wifi_password"

api:
  password: "very_secret_api_key"

ota:
  password: "very_secret_ota_pw"
`.trim();

    const result = esphomeYamlConverter.convert(yaml, "/config/test.yaml");
    expect(result.markdown).not.toContain("very_secret_wifi_password");
    expect(result.markdown).not.toContain("very_secret_api_key");
    expect(result.markdown).not.toContain("very_secret_ota_pw");
    expect(result.markdown).toContain("[REDACTED]");
    // SSID is not sensitive
    expect(result.markdown).toContain("TestNetwork");
  });

  it("handles !secret directives in wifi password", () => {
    const yaml = `
esphome:
  name: secret_device

esp8266:
  board: d1_mini

wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password
`.trim();

    const result = esphomeYamlConverter.convert(yaml, "/config/device.yaml");
    // !secret gets replaced with [REDACTED] by our schema
    expect(result.markdown).not.toContain("wifi_password");
    expect(result.markdown).toContain("[REDACTED]");
    expect(result.metadata["platform"]).toBe("ESP8266");
  });

  it("handles minimal ESPHome config (board only)", () => {
    const yaml = `
esphome:
  name: minimal_device

esp32:
  board: lolin32
`.trim();

    const result = esphomeYamlConverter.convert(yaml, "/config/minimal.yaml");
    expect(result.title).toBe("ESPHome Device: minimal_device");
    expect(result.markdown).toContain("## Board");
    expect(result.markdown).toContain("lolin32");
    expect(result.metadata["sensorCount"]).toBe(0);
  });

  it("handles ESP8266 device", () => {
    const yaml = `
esphome:
  name: wemos_node

esp8266:
  board: d1_mini

sensor:
  - platform: dht
    pin: D4
    temperature:
      name: "Room Temp"
    humidity:
      name: "Room Humidity"
`.trim();

    const result = esphomeYamlConverter.convert(yaml, "/config/wemos.yaml");
    expect(result.markdown).toContain("ESP8266");
    expect(result.markdown).toContain("d1_mini");
    expect(result.metadata["platform"]).toBe("ESP8266");
  });

  it("includes static IP in WiFi section", () => {
    const yaml = `
esphome:
  name: static_ip_device

esp32:
  board: esp32dev

wifi:
  ssid: "Network"
  password: "pass"
  manual_ip:
    static_ip: 192.168.10.50
    gateway: 192.168.10.1
    subnet: 255.255.255.0
`.trim();

    const result = esphomeYamlConverter.convert(yaml, "/config/static.yaml");
    expect(result.markdown).toContain("192.168.10.50");
    expect(result.markdown).not.toContain("pass");
  });

  it("handles empty/invalid YAML gracefully", () => {
    const result = esphomeYamlConverter.convert("", "/config/empty.yaml");
    expect(result.title).toContain("empty.yaml");
    // Should not throw
  });

  it("handles output section", () => {
    const yaml = `
esphome:
  name: pwm_device

esp32:
  board: esp32dev

output:
  - platform: ledc
    pin: GPIO25
    id: pwm_out_1
    frequency: 1000Hz
`.trim();

    const result = esphomeYamlConverter.convert(yaml, "/config/pwm.yaml");
    expect(result.markdown).toContain("## Switches/Outputs");
    expect(result.markdown).toContain("pwm_out_1");
  });

  it("handles !secret in sequence items", () => {
    const yaml = `
esphome:
  name: test_device

esp32:
  board: esp32dev

wifi:
  networks:
    - ssid: "Network1"
      password: !secret wifi_pass_1
    - ssid: "Network2"
      password: !secret wifi_pass_2
`.trim();

    const result = esphomeYamlConverter.convert(yaml, "/config/multi-wifi.yaml");
    expect(result.markdown).toContain("test_device");
    // Secrets should be redacted
    expect(result.markdown).not.toContain("wifi_pass_1");
    expect(result.markdown).not.toContain("wifi_pass_2");
  });
});
