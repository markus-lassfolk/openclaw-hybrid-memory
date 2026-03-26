import { Type, type TSchema } from "@sinclair/typebox";

/**
 * Local compatibility helper for string union schemas.
 *
 * OpenClaw 2026.3.24 removed `stringEnum` from `openclaw/plugin-sdk`.
 * Keep schema construction internal so plugin startup no longer depends on SDK exports.
 */
export function stringEnum(values: readonly string[]): TSchema {
  const literals = values.map((value) => Type.Literal(value));

  if (literals.length === 0) {
    return Type.Never();
  }

  if (literals.length === 1) {
    return literals[0] as TSchema;
  }

  return Type.Union(literals as [TSchema, TSchema, ...TSchema[]]);
}
