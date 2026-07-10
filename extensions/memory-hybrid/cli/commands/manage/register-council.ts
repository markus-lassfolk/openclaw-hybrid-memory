/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import type { CouncilProvenanceMode } from "../../../config/types/maintenance.js";
import { buildCouncilSessionKey, buildProvenanceMetadata, generateTraceId } from "../../../utils/provenance.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

const COUNCIL_PROVENANCE_MODES: readonly CouncilProvenanceMode[] = ["meta+receipt", "meta", "receipt", "none"];

export function registerManageCouncil(mem: Chainable, b: ManageBindings): void {
  const { cfg } = b;

  // Issue #280 — Council provenance utility command
  const council = mem.command("council").description("Council review provenance utilities (Issue #280).");

  council
    .command("provenance-headers")
    .description(
      "Generate ACP provenance headers for a council review session. " +
        "Output is JSON — pass to sessions_spawn or embed in review comments.",
    )
    .option("--session-key <key>", "Session key for this council member (e.g. council-review-pr-283)")
    .option("--member <name>", "Council member name/label (e.g. 'Gemini Architect')")
    .option("--trace-id <id>", "Shared trace ID for this council run (auto-generated if omitted)")
    .option("--parent-session <session>", "Orchestrator session key (e.g. 'main')")
    .option("--mode <mode>", "Provenance mode: meta+receipt | meta | receipt | none (from config if omitted)")
    .action(
      withExit(
        async (opts?: {
          sessionKey?: string;
          member?: string;
          traceId?: string;
          parentSession?: string;
          mode?: string;
        }) => {
          if (opts?.mode && !COUNCIL_PROVENANCE_MODES.includes(opts.mode as CouncilProvenanceMode)) {
            console.error(`error: --mode must be one of: ${COUNCIL_PROVENANCE_MODES.join(", ")} (got "${opts.mode}")`);
            process.exitCode = 1;
            return;
          }
          const configMode = cfg.maintenance?.council?.provenance ?? "meta+receipt";
          const mode = (opts?.mode as CouncilProvenanceMode | undefined) ?? configMode;
          const sessionKeyPrefix = cfg.maintenance?.council?.sessionKeyPrefix ?? "council-review";
          const sessionKey = opts?.sessionKey?.trim() || buildCouncilSessionKey(sessionKeyPrefix);

          const { headers, receipt } = buildProvenanceMetadata(mode, sessionKey, {
            councilMember: opts?.member,
            traceId: opts?.traceId,
            parentSession: opts?.parentSession,
          });

          console.log(JSON.stringify({ sessionKey, mode, headers, receipt }, null, 2));
        },
      ),
    );

  council
    .command("trace-id")
    .description("Generate a unique trace ID for a council review run.")
    .action(
      withExit(async () => {
        console.log(generateTraceId());
      }),
    );
}
