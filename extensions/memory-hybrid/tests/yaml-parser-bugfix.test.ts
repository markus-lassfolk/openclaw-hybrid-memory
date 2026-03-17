import { describe, it, expect } from "vitest";
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
});
