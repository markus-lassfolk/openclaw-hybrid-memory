import { describe, expect, it } from "vitest";
import { haYamlConverter } from "../../tools/converters/ha-yaml-converter.js";

describe("haYamlConverter", () => {
  it("handles a full HA config with automations, scripts, scenes", () => {
    const yaml = `
homeassistant:
  name: "My Home"
  latitude: 59.3
  longitude: 18.0
  unit_system: metric

automation:
  - alias: "Turn on lights at sunset"
    trigger:
      - platform: sun
        event: sunset
    action:
      - service: light.turn_on
        target:
          entity_id: light.living_room

script:
  good_morning:
    alias: "Good Morning"
    sequence:
      - service: light.turn_on
      - delay: "00:00:05"

scene:
  - name: "Evening Chill"
    entities:
      light.living_room:
        state: on
        brightness: 100
`.trim();

    const result = haYamlConverter.convert(yaml, "/config/configuration.yaml");
    expect(result.title).toContain("Home Assistant Configuration");
    expect(result.markdown).toContain("## Automations");
    expect(result.markdown).toContain("Turn on lights at sunset");
    expect(result.markdown).toContain("## Scripts");
    expect(result.markdown).toContain("Good Morning");
    expect(result.markdown).toContain("## Scenes");
    expect(result.markdown).toContain("Evening Chill");
    expect(result.markdown).toContain("## Global Config");
    expect(result.metadata.automationCount).toBe(1);
    expect(result.metadata.scriptCount).toBe(1);
    expect(result.metadata.sceneCount).toBe(1);
  });

  it("handles a minimal config with just sensors", () => {
    const yaml = `
sensor:
  - platform: template
    sensors:
      temperature:
        friendly_name: "Temperature"
        value_template: "{{ states('sensor.raw_temp') }}"
`.trim();

    const result = haYamlConverter.convert(yaml, "/config/sensors.yaml");
    expect(result.markdown).toContain("## Sensors");
    expect(result.markdown).not.toContain("## Automations");
  });

  it("handles !include and !secret gracefully without failing", () => {
    const yaml = `
homeassistant:
  name: !secret home_name

automation: !include automations.yaml
sensor: !include_dir_list sensors/
`.trim();

    const result = haYamlConverter.convert(yaml, "/config/configuration.yaml");
    expect(result.markdown).toContain("# Home Assistant Configuration");
    expect(result.markdown).toContain("## Referenced Files");
    expect(result.markdown).toContain("automations.yaml");
  });

  it("handles empty / invalid YAML gracefully", () => {
    const result = haYamlConverter.convert("", "/config/empty.yaml");
    expect(result.title).toContain("empty.yaml");
    expect(result.markdown).toContain("# Home Assistant Configuration");
    // No sections should crash
  });

  it("handles binary_sensor and switch sections", () => {
    const yaml = `
binary_sensor:
  - platform: ping
    host: 192.168.1.1
    name: "Router Online"

switch:
  - platform: tplink
    host: 192.168.1.50
    name: "Desk Lamp"
`.trim();

    const result = haYamlConverter.convert(yaml, "/config/devices.yaml");
    expect(result.markdown).toContain("## Binary Sensors");
    expect(result.markdown).toContain("Router Online");
    expect(result.markdown).toContain("## Switches");
    expect(result.markdown).toContain("Desk Lamp");
  });

  it("handles multiple automations with complex triggers", () => {
    const yaml = `
automation:
  - alias: "Morning Routine"
    trigger:
      - platform: time
        at: "07:00:00"
    condition:
      - condition: state
        entity_id: input_boolean.guest_mode
        state: "off"
    action:
      - service: light.turn_on
      - service: media_player.play_media

  - alias: "Security Alert"
    trigger:
      - platform: state
        entity_id: binary_sensor.door
        to: "on"
    action:
      - service: notify.mobile_app
`.trim();

    const result = haYamlConverter.convert(yaml, "/config/automations.yaml");
    expect(result.metadata.automationCount).toBe(2);
    expect(result.markdown).toContain("Morning Routine");
    expect(result.markdown).toContain("Security Alert");
    expect(result.markdown).toContain("time(07:00:00)");
  });

  it("renders light entities", () => {
    const yaml = `
light:
  - platform: mqtt
    name: "Kitchen Light"
    unique_id: kitchen_light_001
    command_topic: "home/kitchen/light/set"
`.trim();

    const result = haYamlConverter.convert(yaml, "/config/lights.yaml");
    expect(result.markdown).toContain("## Lights");
    expect(result.markdown).toContain("Kitchen Light");
  });

  it("returns correct file path in metadata", () => {
    const yaml = "sensor:\n  - platform: template\n    name: test\n";
    const result = haYamlConverter.convert(yaml, "/home/user/ha/sensors.yaml");
    expect(result.metadata.filePath).toBe("/home/user/ha/sensors.yaml");
    expect(result.metadata.source).toBe("ha-yaml-converter");
  });

  it("handles a config with no recognisable HA keys", () => {
    const yaml = `
some_unknown_key:
  value: 123
`.trim();

    const result = haYamlConverter.convert(yaml, "/config/unknown.yaml");
    expect(result.markdown).toContain("# Home Assistant Configuration");
    // Should not crash
  });

  it("handles !include in sequence items (split automation files)", () => {
    const yaml = `
automation:
  - !include automations/lights.yaml
  - !include automations/motion.yaml
  - alias: "Inline automation"
    trigger:
      - platform: state
        entity_id: sensor.test
    action:
      - service: light.turn_on
`.trim();

    const result = haYamlConverter.convert(yaml, "/config/configuration.yaml");
    expect(result.markdown).toContain("## Automations");
    expect(result.markdown).toContain("## Referenced Files");
    expect(result.markdown).toContain("automations/lights.yaml");
    expect(result.markdown).toContain("automations/motion.yaml");
    expect(result.markdown).toContain("Inline automation");
    // Should not show *(invalid)* for included files
    expect(result.markdown).not.toContain("Automation 1: *(invalid)*");
    expect(result.markdown).not.toContain("Automation 2: *(invalid)*");
  });

  it("handles !secret in sequence items", () => {
    const yaml = `
notify:
  - name: pushbullet
    platform: pushbullet
    api_key: !secret pushbullet_key
script:
  test_script:
    sequence:
      - service: notify.mobile_app
        data:
          message: !secret test_message
`.trim();

    const result = haYamlConverter.convert(yaml, "/config/configuration.yaml");
    expect(result.markdown).toContain("## Scripts");
    expect(result.markdown).toContain("test_script");
    // Should handle secrets gracefully
    expect(result.markdown).not.toContain("pushbullet_key");
    expect(result.markdown).not.toContain("test_message");
  });

  it("handles keys with hyphens and dots", () => {
    const yaml = `
homeassistant:
  name: "Test Home"

api-key: !secret my_api_key
sensor.temperature: !secret temp_sensor
mqtt-broker: !secret mqtt_host
device.id: !secret device_identifier
`.trim();

    const result = haYamlConverter.convert(yaml, "/config/configuration.yaml");
    // Should not crash and should handle the secrets
    expect(result.markdown).toContain("# Home Assistant Configuration");
    // Secret references should not appear in output
    expect(result.markdown).not.toContain("my_api_key");
    expect(result.markdown).not.toContain("temp_sensor");
    expect(result.markdown).not.toContain("mqtt_host");
    expect(result.markdown).not.toContain("device_identifier");
  });
});
