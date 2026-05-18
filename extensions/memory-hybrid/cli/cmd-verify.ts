/**
 * CLI Verify Command Handler
 *
 * Checks infrastructure (SQLite, LanceDB, embeddings, LLM credentials,
 * cron jobs) and optionally applies fixes.
 */

import type { HandlerContext } from "./handlers.js";
import type { VerifyCliSink } from "./types.js";
import { getCachedFactCount, readApproxFactsRowCount, resetVerifyFactCountCacheForTests } from "./verify/fact-count.js";
import { computeVectorSqliteOrphans } from "./verify/orphans.js";
import { runVerifyConfigCronSection } from "./verify/sections/config-cron.js";
import { runVerifyEmbeddingsSection } from "./verify/sections/embeddings.js";
import { runVerifyInfrastructureSection } from "./verify/sections/infrastructure.js";
import { runVerifyLlmModelsSection } from "./verify/sections/llm-models.js";
import { runVerifyReconcileSection } from "./verify/sections/reconcile.js";
import { createVerifyRunState, type VerifyRunOpts } from "./verify/verify-run-state.js";

export { computeVectorSqliteOrphans, getCachedFactCount, readApproxFactsRowCount, resetVerifyFactCountCacheForTests };

export async function runVerifyForCli(ctx: HandlerContext, opts: VerifyRunOpts, sink: VerifyCliSink): Promise<void> {
  const state = createVerifyRunState(ctx, opts, sink);
  await runVerifyInfrastructureSection(state);
  await runVerifyEmbeddingsSection(state);
  await runVerifyLlmModelsSection(state);
  await runVerifyConfigCronSection(state);
  await runVerifyReconcileSection(state);
}
