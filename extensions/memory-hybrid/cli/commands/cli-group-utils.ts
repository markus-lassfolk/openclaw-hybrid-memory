/**
 * Shared helpers for grouped CLI registration and deprecated flat aliases.
 */

import type { Chainable } from "../shared.js";
import { createCommandGroup, withDeprecationWarning } from "../shared.js";

export type DistillCommandNames = {
  distill: string;
  distillWindow: string;
  recordDistill: string;
  extractDaily: string;
  extractProcedures: string;
  extractDirectives: string;
  extractReinforcement: string;
};

export const FLAT_DISTILL_COMMAND_NAMES: DistillCommandNames = {
  distill: "distill",
  distillWindow: "distill-window",
  recordDistill: "record-distill",
  extractDaily: "extract-daily",
  extractProcedures: "extract-procedures",
  extractDirectives: "extract-directives",
  extractReinforcement: "extract-reinforcement",
};

export const GROUPED_DISTILL_COMMAND_NAMES: DistillCommandNames = {
  distill: "run",
  distillWindow: "window",
  recordDistill: "record",
  extractDaily: "extract-daily",
  extractProcedures: "extract-procedures",
  extractDirectives: "extract-directives",
  extractReinforcement: "extract-reinforcement",
};

export type ReflectCommandNames = {
  patterns: string;
  rules: string;
  meta: string;
  identity: string;
  dream: string;
};

export const FLAT_REFLECT_COMMAND_NAMES: ReflectCommandNames = {
  patterns: "reflect",
  rules: "reflect-rules",
  meta: "reflect-meta",
  identity: "reflect-identity",
  dream: "dream-cycle",
};

export const GROUPED_REFLECT_COMMAND_NAMES: ReflectCommandNames = {
  patterns: "patterns",
  rules: "rules",
  meta: "meta",
  identity: "identity",
  dream: "dream",
};

export type StorageCommandNames = {
  stats: string;
  compact: string;
  retier: string;
  optimize: string;
  health: string;
  reembed: string;
  reIndex: string;
  repair: string;
  rebuildAliases: string;
  prune: string;
  checkpoint: string;
  recordSample: string;
  artifacts: string;
};

export const FLAT_STORAGE_COMMAND_NAMES: StorageCommandNames = {
  stats: "stats",
  compact: "tier-compact",
  retier: "retier",
  optimize: "vectordb-optimize",
  health: "vectordb-health",
  reembed: "reembed-vectorless",
  reIndex: "re-index",
  repair: "repair-vectors",
  rebuildAliases: "rebuild-aliases",
  prune: "prune",
  checkpoint: "checkpoint",
  recordSample: "record-storage-sample",
  artifacts: "classification-artifacts",
};

export const GROUPED_STORAGE_COMMAND_NAMES: StorageCommandNames = {
  stats: "stats",
  compact: "compact",
  retier: "retier",
  optimize: "optimize",
  health: "health",
  reembed: "reembed",
  reIndex: "re-index",
  repair: "repair",
  rebuildAliases: "rebuild-aliases",
  prune: "prune",
  checkpoint: "checkpoint",
  recordSample: "record-sample",
  artifacts: "artifacts",
};

export type QualityCommandNames = {
  duplicates: string;
  consolidate: string;
  consolidateEpisodes: string;
  contradictions: string;
  classify: string;
  enrich: string;
  buildLanguages: string;
};

export const FLAT_QUALITY_COMMAND_NAMES: QualityCommandNames = {
  duplicates: "find-duplicates",
  consolidate: "consolidate",
  consolidateEpisodes: "consolidate-episodes",
  contradictions: "resolve-contradictions",
  classify: "classify",
  enrich: "enrich-entities",
  buildLanguages: "build-languages",
};

export const GROUPED_QUALITY_COMMAND_NAMES: QualityCommandNames = {
  duplicates: "duplicates",
  consolidate: "consolidate",
  consolidateEpisodes: "consolidate-episodes",
  contradictions: "contradictions",
  classify: "classify",
  enrich: "enrich",
  buildLanguages: "build-languages",
};

export type LearnCommandNames = {
  selfCorrectionExtract: string;
  selfCorrectionRun: string;
  feedback: string;
  implicit: string;
  crossAgent: string;
  tools: string;
};

export const FLAT_LEARN_COMMAND_NAMES: LearnCommandNames = {
  selfCorrectionExtract: "self-correction-extract",
  selfCorrectionRun: "self-correction-run",
  feedback: "analyze-feedback-phrases",
  implicit: "extract-implicit",
  crossAgent: "cross-agent-learning",
  tools: "tool-effectiveness",
};

export const GROUPED_LEARN_COMMAND_NAMES: LearnCommandNames = {
  selfCorrectionExtract: "extract",
  selfCorrectionRun: "run",
  feedback: "feedback",
  implicit: "implicit",
  crossAgent: "cross-agent",
  tools: "tools",
};

export type MaintenanceCommandNames = {
  runAll: string;
  cronHealth: string;
  validateExit: string;
  reconcileLedgers: string;
  analyzeLogs: string;
  coverage: string;
  schedule: string;
  backfillRecallEvents: string;
  backfillReflectionWatermark: string;
  backfillDailyLogs: string;
  backfillSessionLanguages: string;
  backfillWorkflowTraces: string;
};

export const FLAT_MAINTENANCE_COMMAND_NAMES: MaintenanceCommandNames = {
  runAll: "run-all",
  cronHealth: "cron-health",
  validateExit: "validate-cron-exit",
  reconcileLedgers: "reconcile-cron-ledgers",
  analyzeLogs: "analyze-maintenance-logs",
  coverage: "maintenance-coverage",
  schedule: "schedule",
  backfillRecallEvents: "backfill-recall-events",
  backfillReflectionWatermark: "backfill-reflection-watermark",
  backfillDailyLogs: "backfill-daily-logs",
  backfillSessionLanguages: "backfill-session-languages",
  backfillWorkflowTraces: "backfill-workflow-traces",
};

export const GROUPED_MAINTENANCE_COMMAND_NAMES: MaintenanceCommandNames = {
  runAll: "run-all",
  cronHealth: "cron-health",
  validateExit: "validate-exit",
  reconcileLedgers: "reconcile-ledgers",
  analyzeLogs: "analyze-logs",
  coverage: "coverage",
  schedule: "schedule",
  backfillRecallEvents: "recall-events",
  backfillReflectionWatermark: "reflection-watermark",
  backfillDailyLogs: "daily-logs",
  backfillSessionLanguages: "session-languages",
  backfillWorkflowTraces: "workflow-traces",
};

/** Wrap a handler for a deprecated flat alias (stderr warning only). */
export function deprecatedAction<A extends unknown[]>(
  oldPath: string,
  newPath: string,
  fn: (...args: A) => void | Promise<void>,
): (...args: A) => void | Promise<void> {
  return withDeprecationWarning(oldPath, newPath, fn);
}

/** @deprecated Prefer `deprecatedAction` — same behavior. */
export const registerDeprecatedAlias = deprecatedAction;

/** Wrap a Commander chain to rename subcommand registrations. */
export function wrapChainableWithRenames(
  base: Chainable,
  renames: Record<string, string>,
  defaultSubcommands: Record<string, boolean> = {},
): Chainable {
  const wrap = (node: Chainable): Chainable => {
    const wrapped: Chainable = {
      command(name: string) {
        const renamed = renames[name] ?? name;
        const isDefault = defaultSubcommands[name] === true;
        const next = isDefault
          ? (node.command as (n: string, opts?: unknown) => Chainable)(renamed, { isDefault: true })
          : node.command(renamed);
        return wrap(next);
      },
      description(desc: string) {
        node.description(desc);
        return wrapped;
      },
      action(fn: (...args: unknown[]) => void | Promise<void>) {
        node.action(fn);
        return wrapped;
      },
      option(flags: string, desc?: string, defaultValue?: unknown) {
        node.option(flags, desc, defaultValue);
        return wrapped;
      },
      requiredOption(flags: string, desc?: string, defaultValue?: unknown) {
        node.requiredOption(flags, desc, defaultValue);
        return wrapped;
      },
      alias(name: string) {
        node.alias?.(name);
        return wrapped;
      },
      argument(name: string, desc?: string) {
        node.argument?.(name, desc);
        return wrapped;
      },
    };
    return wrapped;
  };
  return wrap(base);
}

/** Wrap a Commander chain to emit deprecation warnings for flat top-level aliases. */
export function wrapChainableWithDeprecated(base: Chainable, flatToGrouped: Record<string, string>): Chainable {
  const wrap = (node: Chainable, currentFlat?: string): Chainable => {
    const wrapped: Chainable = {
      command(name: string) {
        return wrap(node.command(name), name);
      },
      description(desc: string) {
        node.description(desc);
        return wrapped;
      },
      action(fn: (...args: unknown[]) => void | Promise<void>) {
        const grouped = currentFlat ? flatToGrouped[currentFlat] : undefined;
        node.action(grouped ? deprecatedAction(currentFlat!, grouped, fn) : fn);
        return wrapped;
      },
      option(flags: string, desc?: string, defaultValue?: unknown) {
        node.option(flags, desc, defaultValue);
        return wrapped;
      },
      requiredOption(flags: string, desc?: string, defaultValue?: unknown) {
        node.requiredOption(flags, desc, defaultValue);
        return wrapped;
      },
      alias(name: string) {
        node.alias?.(name);
        return wrapped;
      },
      argument(name: string, desc?: string) {
        node.argument?.(name, desc);
        return wrapped;
      },
    };
    return wrapped;
  };
  return wrap(base);
}

export { createCommandGroup };
