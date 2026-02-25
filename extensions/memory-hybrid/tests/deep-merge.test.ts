/**
 * deep-merge.test.ts — Unit tests for the deepMerge function.
 *
 * ## Coverage
 *
 * ### Prototype Pollution Prevention
 * - Verifies that `__proto__` keys are skipped during merge
 * - Verifies that `constructor` keys are skipped during merge
 * - Verifies that `prototype` keys are skipped during merge
 * - Ensures Object.prototype is not polluted after merge operations
 * - Tests nested objects with prototype-related keys
 *
 * ### Normal Merge Behavior
 * - Merges simple properties correctly
 * - Recursively merges nested objects
 * - Only adds properties that are undefined in target
 * - Does not overwrite existing properties in target
 * - Handles arrays correctly (treats them as values, not objects to merge)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { _testing } from "../index.js";

const { deepMerge } = _testing;

describe("deepMerge - Prototype Pollution Prevention", () => {
  beforeEach(() => {
    // Ensure Object.prototype is clean before each test
    delete (Object.prototype as Record<string, unknown>).polluted;
    delete (Object.prototype as Record<string, unknown>).isAdmin;
    delete (Object.prototype as Record<string, unknown>).evilProperty;
  });

  it("blocks __proto__ key from polluting Object.prototype", () => {
    const target = {};
    const maliciousSource = JSON.parse('{"__proto__": {"polluted": "yes"}}');
    
    deepMerge(target, maliciousSource);
    
    // Verify Object.prototype was not polluted
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("blocks constructor key from being merged", () => {
    const target: Record<string, unknown> = {};
    const maliciousSource = {
      constructor: {
        prototype: {
          isAdmin: true,
        },
      },
    };
    
    deepMerge(target, maliciousSource);
    
    // Verify Object.prototype was not polluted
    expect((Object.prototype as Record<string, unknown>).isAdmin).toBeUndefined();
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    // Target should not have constructor key added
    expect(target.constructor).toBeDefined(); // constructor exists naturally on objects
    expect((target.constructor as Record<string, unknown>).prototype).not.toHaveProperty("isAdmin");
  });

  it("blocks prototype key from being merged", () => {
    const target: Record<string, unknown> = {};
    const maliciousSource = {
      prototype: {
        evilProperty: "evil",
      },
    };
    
    deepMerge(target, maliciousSource);
    
    // Verify the prototype key was not added to target
    expect(target.prototype).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).evilProperty).toBeUndefined();
  });

  it("blocks nested __proto__ in deep objects", () => {
    const target: Record<string, unknown> = {
      config: {},
    };
    const maliciousSource = {
      config: JSON.parse('{"__proto__": {"polluted": "nested"}}'),
    };
    
    deepMerge(target, maliciousSource);
    
    // Verify Object.prototype was not polluted
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("handles multiple dangerous keys in same object", () => {
    const target: Record<string, unknown> = {};
    const maliciousSource = JSON.parse(`{
      "__proto__": {"polluted1": "yes"},
      "constructor": {"polluted2": "yes"},
      "prototype": {"polluted3": "yes"},
      "safeKey": "safeValue"
    }`);
    
    deepMerge(target, maliciousSource);
    
    // Verify Object.prototype was not polluted
    expect((Object.prototype as Record<string, unknown>).polluted1).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted2).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted3).toBeUndefined();
    
    // But safe keys should be merged
    expect(target.safeKey).toBe("safeValue");
  });

  it("prevents pollution through deeply nested __proto__", () => {
    const target: Record<string, unknown> = {
      level1: {
        level2: {},
      },
    };
    const maliciousSource = {
      level1: {
        level2: JSON.parse('{"__proto__": {"deepPollution": "yes"}}'),
      },
    };
    
    deepMerge(target, maliciousSource);
    
    // Verify Object.prototype was not polluted at any level
    expect((Object.prototype as Record<string, unknown>).deepPollution).toBeUndefined();
    expect(({} as Record<string, unknown>).deepPollution).toBeUndefined();
  });
});

describe("deepMerge - Normal Merge Behavior", () => {
  it("merges simple properties correctly", () => {
    const target: Record<string, unknown> = { a: 1 };
    const source: Record<string, unknown> = { b: 2 };
    
    deepMerge(target, source);
    
    expect(target).toEqual({ a: 1, b: 2 });
  });

  it("recursively merges nested objects", () => {
    const target: Record<string, unknown> = {
      config: {
        database: { host: "localhost" },
      },
    };
    const source: Record<string, unknown> = {
      config: {
        database: { port: 5432 },
        cache: { enabled: true },
      },
    };
    
    deepMerge(target, source);
    
    expect(target).toEqual({
      config: {
        database: { host: "localhost", port: 5432 },
        cache: { enabled: true },
      },
    });
  });

  it("does not overwrite existing properties in target", () => {
    const target: Record<string, unknown> = { a: 1, b: 2 };
    const source: Record<string, unknown> = { b: 999, c: 3 };
    
    deepMerge(target, source);
    
    // b should remain 2, not be overwritten to 999
    expect(target).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("only adds properties that are undefined in target", () => {
    const target: Record<string, unknown> = {
      existing: "keep this",
      nested: { prop: "original" },
    };
    const source: Record<string, unknown> = {
      existing: "don't use this",
      nested: { prop: "don't use this", newProp: "add this" },
      newKey: "add this too",
    };
    
    deepMerge(target, source);
    
    expect(target).toEqual({
      existing: "keep this",
      nested: { prop: "original", newProp: "add this" },
      newKey: "add this too",
    });
  });

  it("handles arrays as values, not objects to merge", () => {
    const target: Record<string, unknown> = {
      items: [1, 2, 3],
    };
    const source: Record<string, unknown> = {
      items: [4, 5, 6],
      newArray: [7, 8, 9],
    };
    
    deepMerge(target, source);
    
    // Arrays should not be merged; existing array is kept, new array is added
    expect(target.items).toEqual([1, 2, 3]);
    expect(target.newArray).toEqual([7, 8, 9]);
  });

  it("handles null values correctly", () => {
    const target: Record<string, unknown> = { a: null };
    const source: Record<string, unknown> = { a: { nested: "value" }, b: null };
    
    deepMerge(target, source);
    
    // null in target should not be merged into
    expect(target.a).toBeNull();
    expect(target.b).toBeNull();
  });

  it("handles empty objects", () => {
    const target: Record<string, unknown> = {};
    const source: Record<string, unknown> = { a: 1, b: { c: 2 } };
    
    deepMerge(target, source);
    
    expect(target).toEqual({ a: 1, b: { c: 2 } });
  });

  it("handles source with no properties", () => {
    const target: Record<string, unknown> = { a: 1 };
    const source: Record<string, unknown> = {};
    
    deepMerge(target, source);
    
    expect(target).toEqual({ a: 1 });
  });

  it("merges multiple levels of nesting", () => {
    const target: Record<string, unknown> = {
      level1: {
        level2: {
          level3: {
            existing: "value",
          },
        },
      },
    };
    const source: Record<string, unknown> = {
      level1: {
        level2: {
          level3: {
            newProp: "newValue",
          },
          newLevel3: "added",
        },
      },
    };
    
    deepMerge(target, source);
    
    expect(target).toEqual({
      level1: {
        level2: {
          level3: {
            existing: "value",
            newProp: "newValue",
          },
          newLevel3: "added",
        },
      },
    });
  });

  it("preserves different data types", () => {
    const target: Record<string, unknown> = {
      string: "text",
      number: 42,
      boolean: true,
    };
    const source: Record<string, unknown> = {
      newString: "more text",
      newNumber: 100,
      newBoolean: false,
      newNull: null,
    };
    
    deepMerge(target, source);
    
    expect(target).toEqual({
      string: "text",
      number: 42,
      boolean: true,
      newString: "more text",
      newNumber: 100,
      newBoolean: false,
      newNull: null,
    });
  });
});

describe("deepMerge - Edge Cases", () => {
  it("handles objects with numeric keys", () => {
    const target: Record<string, unknown> = { "0": "zero" };
    const source: Record<string, unknown> = { "1": "one" };
    
    deepMerge(target, source);
    
    expect(target).toEqual({ "0": "zero", "1": "one" });
  });

  it("handles objects with special characters in keys", () => {
    const target: Record<string, unknown> = { "key-with-dash": "value1" };
    const source: Record<string, unknown> = { "key.with.dot": "value2", "key with space": "value3" };
    
    deepMerge(target, source);
    
    expect(target).toEqual({
      "key-with-dash": "value1",
      "key.with.dot": "value2",
      "key with space": "value3",
    });
  });

  it("does not merge when target property is not an object", () => {
    const target: Record<string, unknown> = {
      config: "string value",
    };
    const source: Record<string, unknown> = {
      config: { nested: "object" },
    };
    
    deepMerge(target, source);
    
    // config should remain a string, not be replaced or merged
    expect(target.config).toBe("string value");
  });

  it("does not merge when source property is not an object", () => {
    const target: Record<string, unknown> = {
      config: { existing: "value" },
    };
    const source: Record<string, unknown> = {
      config: "string value",
    };
    
    deepMerge(target, source);
    
    // config should remain an object, not be replaced
    expect(target.config).toEqual({ existing: "value" });
  });
});
