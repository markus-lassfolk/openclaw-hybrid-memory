/**
 * Grouped `quality` CLI commands.
 */

import type { ManageBindings } from "../context.js";
import type { Chainable } from "../shared.js";
import {
  createCommandGroup,
  GROUPED_QUALITY_COMMAND_NAMES,
  wrapChainableWithDeprecated,
  wrapChainableWithRenames,
} from "./cli-group-utils.js";
import { registerManageReflectionPipeline } from "./manage/register-reflection-pipeline.js";

const QUALITY_RENAMES: Record<string, string> = {
  "find-duplicates": GROUPED_QUALITY_COMMAND_NAMES.duplicates,
  consolidate: GROUPED_QUALITY_COMMAND_NAMES.consolidate,
  "consolidate-episodes": GROUPED_QUALITY_COMMAND_NAMES.consolidateEpisodes,
  "resolve-contradictions": GROUPED_QUALITY_COMMAND_NAMES.contradictions,
  classify: GROUPED_QUALITY_COMMAND_NAMES.classify,
  "build-languages": GROUPED_QUALITY_COMMAND_NAMES.buildLanguages,
  "enrich-entities": GROUPED_QUALITY_COMMAND_NAMES.enrich,
};

const QUALITY_FLAT_PATHS: Record<string, string> = {
  "find-duplicates": "quality duplicates",
  consolidate: "quality consolidate",
  "consolidate-episodes": "quality consolidate-episodes",
  "resolve-contradictions": "quality contradictions",
  classify: "quality classify",
  "build-languages": "quality build-languages",
  "enrich-entities": "quality enrich",
};

export function registerQualityGroup(mem: Chainable, b: ManageBindings): void {
  const group = createCommandGroup(mem, "quality", "Data quality and deduplication");
  registerManageReflectionPipeline(wrapChainableWithRenames(group, QUALITY_RENAMES), b, { onlyQuality: true });

  registerManageReflectionPipeline(wrapChainableWithDeprecated(mem, QUALITY_FLAT_PATHS), b, { onlyQuality: true });
}
