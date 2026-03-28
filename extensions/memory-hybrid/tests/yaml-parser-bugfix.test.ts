import { describe, expect, it } from "vitest";
import { parseYaml } from "../utils/yaml-parser.js";

describe("yaml-parser bugfixes", () => {
  describe("Bug 1: Comment-only values should not drop nested content", () => {
    it("handles key with inline comment followed by nested block", () => {
      const yaml = `homeassistant: # main config
  name: My Home
  latitude: 59.3
  longitude: 18.0`;

      const result = parseYaml(yaml) as Record<string, any>;
      expect(result).toHaveProperty("homeassistant");
      expect(result.homeassistant).toBeTypeOf("object");
      expect(result.homeassistant).toHaveProperty("name", "My Home");
      expect(result.homeassistant).toHaveProperty("latitude", 59.3);
      expect(result.homeassistant).toHaveProperty("longitude", 18.0);
    });

    it("handles sequence item with inline comment followed by nested mapping", () => {
      const yaml = `items:
  - name: item1 # first item
    value: 100
  - name: item2
    value: 200`;

      const result = parseYaml(yaml) as Record<string, any>;
      expect(result.items).toBeInstanceOf(Array);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toHaveProperty("name", "item1");
      expect(result.items[0]).toHaveProperty("value", 100);
    });

    it("handles nested key with comment-only value", () => {
      const yaml = `automation:
  - alias: Test # automation comment
    trigger:
      - platform: state
        entity_id: sensor.test`;

      const result = parseYaml(yaml) as Record<string, any>;
      expect(result.automation).toBeInstanceOf(Array);
      expect(result.automation[0]).toHaveProperty("alias", "Test");
      expect(result.automation[0]).toHaveProperty("trigger");
      expect(result.automation[0].trigger).toBeInstanceOf(Array);
      expect(result.automation[0].trigger[0]).toHaveProperty("platform", "state");
    });
  });

  describe("Bug 2a: Flow sequence quoted strings preserve type (no coercion)", () => {
    it('keeps ["true"] as string, not boolean', () => {
      const result = parseYaml('flags: ["true", "false"]') as Record<string, any>;
      expect(result.flags).toEqual(["true", "false"]);
      expect(typeof result.flags[0]).toBe("string");
      expect(typeof result.flags[1]).toBe("string");
    });

    it('keeps ["123"] as string, not number', () => {
      const result = parseYaml('ids: ["123", "456"]') as Record<string, any>;
      expect(result.ids).toEqual(["123", "456"]);
      expect(typeof result.ids[0]).toBe("string");
    });

    it("parses unquoted booleans and numbers correctly in flow sequences", () => {
      const result = parseYaml("vals: [true, false, 42, 3.14]") as Record<string, any>;
      expect(result.vals).toEqual([true, false, 42, 3.14]);
    });
  });

  describe("Bug 2: Quoted strings should not be corrupted by tag preprocessing", () => {
    it("preserves quoted strings containing tag-like text in yaml-parser", () => {
      const yaml = `description: "Do not use !secret here"
warning: "Avoid !include in docs"
note: 'Also !secret in single quotes'`;

      const result = parseYaml(yaml) as Record<string, any>;
      expect(result.description).toBe("Do not use !secret here");
      expect(result.warning).toBe("Avoid !include in docs");
      expect(result.note).toBe("Also !secret in single quotes");
    });

    it("handles actual tags correctly", () => {
      const yaml = `password: !secret wifi_pass
config: !include settings.yaml`;

      const result = parseYaml(yaml) as Record<string, any>;
      // These are not valid YAML for our parser (no tag support),
      // but they should at least parse as strings
      expect(result.password).toBeTruthy();
      expect(result.config).toBeTruthy();
    });
  });

  describe("Bug 3: YAML 1.2 boolean parsing (yes/no/on/off are strings)", () => {
    it("parses on/off as strings, not booleans", () => {
      const yaml = `state: on
previous_state: off`;

      const result = parseYaml(yaml) as Record<string, any>;
      expect(result.state).toBe("on");
      expect(typeof result.state).toBe("string");
      expect(result.previous_state).toBe("off");
      expect(typeof result.previous_state).toBe("string");
    });

    it("parses yes/no as strings, not booleans", () => {
      const yaml = `answer: yes
declined: no`;

      const result = parseYaml(yaml) as Record<string, any>;
      expect(result.answer).toBe("yes");
      expect(typeof result.answer).toBe("string");
      expect(result.declined).toBe("no");
      expect(typeof result.declined).toBe("string");
    });

    it("still parses true/false as booleans", () => {
      const yaml = `enabled: true
disabled: false`;

      const result = parseYaml(yaml) as Record<string, any>;
      expect(result.enabled).toBe(true);
      expect(typeof result.enabled).toBe("boolean");
      expect(result.disabled).toBe(false);
      expect(typeof result.disabled).toBe("boolean");
    });

    it("handles mixed case true/false as booleans", () => {
      const yaml = `a: True
b: FALSE
c: TrUe`;

      const result = parseYaml(yaml) as Record<string, any>;
      expect(result.a).toBe(true);
      expect(result.b).toBe(false);
      expect(result.c).toBe(true);
    });

    it("preserves on/off in Home Assistant entity states", () => {
      const yaml = `scene:
  - name: Evening
    entities:
      light.living_room:
        state: on
        brightness: 100
      light.bedroom:
        state: off`;

      const result = parseYaml(yaml) as Record<string, any>;
      const scene = result.scene[0];
      expect(scene.entities["light.living_room"].state).toBe("on");
      expect(typeof scene.entities["light.living_room"].state).toBe("string");
      expect(scene.entities["light.bedroom"].state).toBe("off");
      expect(typeof scene.entities["light.bedroom"].state).toBe("string");
    });
  });
});
