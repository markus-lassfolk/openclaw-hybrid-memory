/**
 * Grouped `reflect` CLI commands.
 */

import type { ManageBindings } from "./manage/bindings.js";
import type { Chainable } from "../shared.js";
import {
  createCommandGroup,
  GROUPED_REFLECT_COMMAND_NAMES,
  wrapChainableWithDeprecated,
  wrapChainableWithRenames,
} from "./cli-group-utils.js";
import { registerManageReflectionPipeline } from "./manage/register-reflection-pipeline.js";

const REFLECT_RENAMES: Record<string, string> = {
  reflect: GROUPED_REFLECT_COMMAND_NAMES.patterns,
  "reflect-rules": GROUPED_REFLECT_COMMAND_NAMES.rules,
  "reflect-meta": GROUPED_REFLECT_COMMAND_NAMES.meta,
  "reflect-identity": GROUPED_REFLECT_COMMAND_NAMES.identity,
  "dream-cycle": GROUPED_REFLECT_COMMAND_NAMES.dream,
};

const REFLECT_FLAT_PATHS: Record<string, string> = {
  reflect: "reflect patterns",
  "reflect-rules": "reflect rules",
  "reflect-meta": "reflect meta",
  "reflect-identity": "reflect identity",
  "dream-cycle": "reflect dream",
};

export function registerReflectGroup(mem: Chainable, b: ManageBindings): void {
  const group = createCommandGroup(mem, "reflect", "Reflection pipeline (patterns, rules, meta, identity, dream)");
  registerManageReflectionPipeline(wrapChainableWithRenames(group, REFLECT_RENAMES, { reflect: true }), b, {
    onlyReflect: true,
  });

  const reflectFlatPaths = Object.fromEntries(
    Object.entries(REFLECT_FLAT_PATHS).filter(([flatName]) => flatName !== "reflect"),
  );
  registerManageReflectionPipeline(wrapChainableWithDeprecated(mem, reflectFlatPaths), b, {
    onlyReflect: true,
    skipReflectMain: true,
  });
}
