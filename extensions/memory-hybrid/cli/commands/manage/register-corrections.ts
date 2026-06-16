import { capturePluginError } from "../../../services/error-reporter.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

export function registerManageCorrections(mem: Chainable, b: ManageBindings): void {
  const { listCommands, runStore } = b;

  const corrections = mem.command("corrections").description("Manage self-correction reports");
  corrections
    .command("list")
    .description("List pending corrections (from latest self-correction run)")
    .option("--workspace <w>", "Workspace path (for TOOLS.md)")
    .action(
      withExit(async (opts?: { workspace?: string }) => {
        if (!listCommands?.listCorrections) {
          console.log("Corrections feature not available.");
          return;
        }
        const { reportPath, items } = await listCommands.listCorrections({ workspace: opts?.workspace });
        if (!reportPath) {
          console.log("No corrections report found.");
          return;
        }
        console.log(`Corrections report: ${reportPath}`);
        console.log(`Pending items (${items.length}):`);
        for (const item of items) {
          console.log(`  - ${item}`);
        }
      }),
    );
  corrections
    .command("approve-all")
    .description("Approve all pending corrections (auto-fix memory + TOOLS.md)")
    .option("--workspace <w>", "Workspace path (for TOOLS.md)")
    .action(
      withExit(async (opts?: { workspace?: string }) => {
        if (!listCommands?.correctionsApproveAll) {
          console.log("Corrections feature not available.");
          return;
        }
        const { applied, error } = await listCommands.correctionsApproveAll({ workspace: opts?.workspace });
        if (error) {
          console.error(`Error applying corrections: ${error}`);
          process.exitCode = 1;
          return;
        }
        console.log(`Applied ${applied} corrections.`);
      }),
    );

  mem
    .command("review")
    .description("Start interactive review of pending proposals + corrections")
    .option("--workspace <w>", "Workspace path (for TOOLS.md)")
    .action(
      withExit(async (opts?: { workspace?: string }) => {
        console.log("=== Interactive Review (proposals + corrections) ===");
        if (!listCommands) {
          console.log("Review feature not available (personaProposals disabled or no workspace).");
          return;
        }
        const proposals = listCommands.listProposals ? await listCommands.listProposals({ status: "pending" }) : [];
        const { reportPath, items: corrections } = listCommands.listCorrections
          ? await listCommands.listCorrections({ workspace: opts?.workspace })
          : { reportPath: null, items: [] };

        console.log(`Pending proposals: ${proposals.length}`);
        console.log(`Pending corrections: ${corrections.length}`);
        console.log("");
        console.log("To approve/reject proposals: hybrid-mem proposals approve <id> | reject <id>");
        console.log("To approve all corrections: hybrid-mem corrections approve-all");
        console.log("");
        console.log("Proposals:");
        for (const p of proposals) {
          console.log(`  [${p.id}] ${p.title} (target=${p.targetFile}, confidence=${p.confidence.toFixed(2)})`);
        }
        console.log("");
        if (reportPath) {
          console.log(`Corrections report: ${reportPath}`);
          for (const item of corrections) {
            console.log(`  - ${item}`);
          }
        } else {
          console.log("No corrections report found.");
        }
      }),
    );

  mem
    .command("store <text>")
    .description("Store a fact (with optional category, entity, key-value, sourceDate, tags, supersedes, scope)")
    .option("--category <cat>", "Category")
    .option("--entity <ent>", "Entity")
    .option("--key <k>", "Key")
    .option("--value <v>", "Value")
    .option("--source-date <d>", "Source date (ISO or timestamp)")
    .option("--tags <t>", "Tags (comma-separated)")
    .option("--supersedes <id>", "Fact ID this store supersedes (replaces)")
    .option("--scope <s>", "Memory scope (global, user, agent, session). Default global.")
    .option(
      "--scope-target <st>",
      "Scope target (userId, agentId, sessionId). Required when scope is user/agent/session.",
    )
    .action(
      withExit(
        async (
          text: string,
          opts?: {
            category?: string;
            entity?: string;
            key?: string;
            value?: string;
            sourceDate?: string;
            tags?: string;
            supersedes?: string;
            scope?: "global" | "user" | "agent" | "session";
            scopeTarget?: string;
          },
        ) => {
          let res;
          try {
            res = await runStore({
              text,
              category: opts?.category,
              entity: opts?.entity,
              key: opts?.key,
              value: opts?.value,
              sourceDate: opts?.sourceDate,
              tags: opts?.tags,
              supersedes: opts?.supersedes,
              scope: opts?.scope,
              scopeTarget: opts?.scopeTarget,
            });
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "store",
            });
            throw err;
          }
          if (res.outcome === "duplicate") {
            console.log("Duplicate fact (skipped).");
          } else if (res.outcome === "credential") {
            console.log(`Credential stored: ${res.service} (${res.type}), id=${res.id}`);
          } else if (res.outcome === "credential_skipped_duplicate") {
            console.log(`Credential already in vault (skipped): ${res.service} (${res.type})`);
          } else if (res.outcome === "credential_blocked_no_vault") {
            console.log("Credential-like content blocked: enable credentials vault to store secrets securely.");
          } else if (res.outcome === "credential_blocked_require_pattern_match") {
            console.log(
              "Credential-like content blocked: no recognizable secret pattern found (requirePatternMatch is enabled).",
            );
          } else if (res.outcome === "credential_parse_error") {
            console.log("Credential parse error (skipped).");
          } else if (res.outcome === "credential_vault_error") {
            console.log("Credential vault error — could not write to secure vault (skipped).");
          } else if (res.outcome === "credential_db_error") {
            console.log("Credential pointer error — vault entry written but pointer storage failed (skipped).");
          } else if (res.outcome === "noop") {
            console.log(`No-op: ${res.reason}`);
          } else if (res.outcome === "retracted") {
            console.log(`Retracted fact ${res.targetId}: ${res.reason}`);
          } else if (res.outcome === "updated") {
            console.log(`Updated fact ${res.id} (superseded ${res.supersededId}): ${res.reason}`);
          } else if (res.outcome === "stored") {
            console.log(
              `Stored: ${res.textPreview} (id=${res.id}${res.supersededId ? `, superseded ${res.supersededId}` : ""})`,
            );
          }
        },
      ),
    );
}
