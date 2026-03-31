import { describe, expect, it } from "vitest";
import type { EntityLookupConfig } from "../config/types/retrieval.js";
import { resolveEntityLookupNames } from "../utils/entity-lookup-resolve.js";

function lookup(overrides: Partial<EntityLookupConfig>): EntityLookupConfig {
  return {
    enabled: true,
    entities: [],
    maxFactsPerEntity: 2,
    autoFromFacts: true,
    maxAutoEntities: 500,
    ...overrides,
  };
}

describe("resolveEntityLookupNames", () => {
  it("returns manual entities when non-empty", () => {
    const names = resolveEntityLookupNames(lookup({ entities: ["owner", "user"] }), {
      getKnownEntities: () => ["db-only"],
    });
    expect(names).toEqual(["owner", "user"]);
  });

  it("returns [] when autoFromFacts is false and entities empty", () => {
    const names = resolveEntityLookupNames(lookup({ autoFromFacts: false, entities: [] }), {
      getKnownEntities: () => ["a", "b"],
    });
    expect(names).toEqual([]);
  });

  it("returns [] when getKnownEntities is missing", () => {
    expect(resolveEntityLookupNames(lookup({}), {})).toEqual([]);
  });

  it("filters empty and whitespace-only strings", () => {
    const names = resolveEntityLookupNames(lookup({}), {
      getKnownEntities: () => ["ok", "", "  ", "also"],
    });
    expect(names).toEqual(["also", "ok"]);
  });

  it("sorts deterministically before capping", () => {
    const names = resolveEntityLookupNames(lookup({ maxAutoEntities: 10 }), {
      getKnownEntities: () => ["zebra", "apple", "Banana"],
    });
    expect(names).toEqual(["apple", "Banana", "zebra"]);
  });

  it("caps at maxAutoEntities after sort", () => {
    const names = resolveEntityLookupNames(lookup({ maxAutoEntities: 2 }), {
      getKnownEntities: () => ["c", "a", "b"],
    });
    expect(names).toEqual(["a", "b"]);
  });

  it("ignores non-string entries from getKnownEntities", () => {
    const names = resolveEntityLookupNames(lookup({}), {
      getKnownEntities: () => ["x", null as unknown as string, "y"],
    });
    expect(names).toEqual(["x", "y"]);
  });
});
