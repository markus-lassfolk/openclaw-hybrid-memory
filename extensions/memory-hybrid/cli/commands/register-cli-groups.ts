/**
 * Central orchestrator for grouped hybrid-mem CLI commands.
 */

import type { ManageContext } from "../context.js";
import type { DistillContext } from "../distill.js";
import { registerDistillGroup } from "../distill.js";
import type { Chainable } from "../shared.js";
import { buildManageBindings } from "./manage/bindings.js";
import { registerStorageGroup } from "./manage/register-storage-maintenance.js";
import { registerDreamGroup } from "./register-dream-group.js";
import { registerLearnGroup } from "./register-learn-group.js";
import { registerMaintenanceGroup } from "./register-maintenance-group.js";
import { registerQualityGroup } from "./register-quality-group.js";
import { registerReflectGroup } from "./register-reflect-group.js";
import { registerResearchGroup } from "./register-research-group.js";
import { registerWikiGroup } from "./register-wiki-group.js";

export function registerAllCliGroups(mem: Chainable, ctx: ManageContext, distillContext: DistillContext): void {
  registerDistillGroup(mem, distillContext);
  const b = buildManageBindings(ctx);
  registerStorageGroup(mem, b);
  registerReflectGroup(mem, b);
  registerDreamGroup(mem, {
    factsDb: ctx.factsDb,
    dreaming: ctx.cfg.dreaming,
    manage: {
      runDistill: ctx.runDistill,
      runSelfCorrectionRun: ctx.runSelfCorrectionRun,
      runContradictionCandidates: ctx.runContradictionCandidates,
      runResolveContradictionsAuto: ctx.runResolveContradictionsAuto,
      runReflection: ctx.runReflection,
      runConsolidate: ctx.runConsolidate,
      runDreamCycle: ctx.runDreamCycle,
    },
  });
  registerQualityGroup(mem, b);
  registerLearnGroup(mem, b);
  registerMaintenanceGroup(mem, b, ctx);
  registerResearchGroup(mem, b);
  registerWikiGroup(mem, ctx);
}
