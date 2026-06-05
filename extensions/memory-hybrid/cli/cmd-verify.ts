import { getCachedFactCount, readApproxFactsRowCount, resetVerifyFactCountCacheForTests } from "./verify/fact-count.js";
import { computeVectorSqliteOrphans } from "./verify/orphans.js";

export { computeVectorSqliteOrphans, getCachedFactCount, readApproxFactsRowCount, resetVerifyFactCountCacheForTests };
import { createVerifyRunState, type VerifyRunOpts } from "./verify/verify-run-state.js";
import { runVerifyInfrastructureSection } from "./verify/sections/infrastructure.js";
import { runVerifyEmbeddingsSection } from "./verify/sections/embeddings.js";
import { runVerifyLlmModelsSection } from "./verify/sections/llm-models.js";
import { runVerifyConfigCronSection } from "./verify/sections/config-cron.js";
import { runVerifyReconcileSection } from "./verify/sections/reconcile.js";
import { runVerifyUiIntegrationsSection } from "./verify/sections/ui-integrations.js";

export async function runVerifyForCli(
  ctx: import("./handlers.js").HandlerContext,
  opts: VerifyRunOpts,
  sink: import("./types.js").VerifyCliSink,
): Promise<void> {
  const state = createVerifyRunState(ctx, opts, sink);
  await runVerifyInfrastructureSection(state);
  await runVerifyEmbeddingsSection(state);
  await runVerifyLlmModelsSection(state);
  await runVerifyConfigCronSection(state);
  await runVerifyUiIntegrationsSection(state);
  await runVerifyReconcileSection(state);
}
