/**
 * Schema-drift guard for the Memory Graph SPA: every GraphQL document the app sends (queries,
 * mutations, subscriptions — collected in graph-app/src/api/documents.ts, a deliberately
 * dependency-free module) must validate against the live schema. A field rename/removal on either
 * side fails here in CI instead of surfacing as a runtime "Cannot query field" in the browser.
 * (The GraphEdge.id gap that shipped earlier was exactly this class of bug.)
 */
import { buildSchema, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import { ALL_GRAPHQL_DOCUMENTS } from "../graph-app/src/api/documents.js";
import { graphqlSchema } from "../routes/graphql-schema.js";

const schema = buildSchema(graphqlSchema);

describe("Memory Graph SPA ↔ GraphQL schema parity", () => {
  it("collects a sane number of documents (guards against an emptied registry)", () => {
    expect(ALL_GRAPHQL_DOCUMENTS.length).toBeGreaterThanOrEqual(20);
  });

  for (const { name, document } of ALL_GRAPHQL_DOCUMENTS) {
    it(`${name} validates against the schema`, () => {
      const errors = validate(schema, parse(document));
      expect(errors.map((e) => e.message)).toEqual([]);
    });
  }
});
