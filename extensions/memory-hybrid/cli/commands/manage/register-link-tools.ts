/**
 * CLI registration for `link create|list|delete` (issue #2090).
 *
 * `memory_link` has been agent-tool-only; operators had no CLI fallback for creating, inspecting,
 * or removing graph links when Tool Search wrappers were stale/degraded. Thin wrappers over the
 * same FactsDB methods the tool uses — no scope filter (CLI is an operator-trusted context, same
 * convention as every other hybrid-mem command that touches factsDb directly).
 */

import { MEMORY_LINK_TYPES, type MemoryLinkType } from "../../../backends/facts-db.js";
import { truncateText } from "../../../utils/text.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

const truncate = (text: string): string => truncateText(text, 50);

export function registerManageLinkTools(mem: Chainable, b: ManageBindings): void {
  const { factsDb } = b;

  const link = mem.command("link").description("Create, inspect, and remove typed links between facts (#2090).");

  link
    .command("create <sourceFactId> <targetFactId>")
    .description(
      `Create a typed link between two facts. Link types: ${MEMORY_LINK_TYPES.join(", ")} (CONTRADICTS is bidirectional and reduces confidence instead of creating a plain link). DERIVED_FROM is not a valid link type — provenance lives on facts.provenance_json.`,
    )
    .requiredOption("--type <linkType>", `Link type (${MEMORY_LINK_TYPES.join("|")})`)
    .option("--strength <n>", "Link strength 0.0-1.0 (default 1.0)", "1.0")
    .option("--json", "Output as JSON")
    .action(
      withExit(
        async (
          sourceFactId: string,
          targetFactId: string,
          opts?: { type?: string; strength?: string; json?: boolean },
        ) => {
          const linkType = opts?.type as MemoryLinkType | undefined;
          if (!linkType || !(MEMORY_LINK_TYPES as readonly string[]).includes(linkType)) {
            throw new Error(`--type must be one of: ${MEMORY_LINK_TYPES.join(", ")}`);
          }
          const strength = Number.parseFloat(opts?.strength ?? "1.0");
          if (!Number.isFinite(strength)) {
            throw new Error(`Invalid --strength value: ${opts?.strength}`);
          }
          const src = factsDb.getById(sourceFactId);
          if (!src) throw new Error(`Source fact not found: ${sourceFactId}`);
          const tgt = factsDb.getById(targetFactId);
          if (!tgt) throw new Error(`Target fact not found: ${targetFactId}`);
          if (sourceFactId === targetFactId) throw new Error(`Cannot link a fact to itself: ${sourceFactId}`);

          if (linkType === "CONTRADICTS") {
            const contradictionId = factsDb.recordContradiction(sourceFactId, targetFactId);
            if (opts?.json) {
              console.log(JSON.stringify({ contradictionId, sourceFactId, targetFactId, linkType }, null, 2));
              return;
            }
            console.log(
              `Created bidirectional CONTRADICTS link from "${truncate(src.text)}" to "${truncate(tgt.text)}" and reduced confidence (contradictionId=${contradictionId})`,
            );
            return;
          }

          const linkId = factsDb.createLink(sourceFactId, targetFactId, linkType, strength);
          // FactsDB.createLink() silently clamps strength to [0,1] before persisting — mirror that
          // clamp here so the reported value matches what was actually stored, not the raw input.
          const persistedStrength = Math.max(0, Math.min(1, strength));
          if (opts?.json) {
            console.log(
              JSON.stringify({ linkId, sourceFactId, targetFactId, linkType, strength: persistedStrength }, null, 2),
            );
            return;
          }
          console.log(
            `Created ${linkType} link from "${truncate(src.text)}" to "${truncate(tgt.text)}" (strength=${persistedStrength}, id=${linkId})`,
          );
        },
      ),
    );

  link
    .command("list <factId>")
    .description("List a fact's outgoing and incoming links")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (factId: string, opts?: { json?: boolean }) => {
        if (!factsDb.getById(factId)) throw new Error(`Fact not found: ${factId}`);
        const outgoing = factsDb.getLinksFrom(factId);
        const incoming = factsDb.getLinksTo(factId);
        if (opts?.json) {
          console.log(JSON.stringify({ factId, outgoing, incoming }, null, 2));
          return;
        }
        if (outgoing.length === 0 && incoming.length === 0) {
          console.log(`No links for fact ${factId}.`);
          return;
        }
        for (const l of outgoing) {
          console.log(`${l.id}  ${factId} -[${l.linkType}, strength=${l.strength}]-> ${l.targetFactId}`);
        }
        for (const l of incoming) {
          console.log(`${l.id}  ${l.sourceFactId} -[${l.linkType}, strength=${l.strength}]-> ${factId}`);
        }
      }),
    );

  link
    .command("delete <linkId>")
    .description("Delete a link by id (decrements graph degree counters where applicable)")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (linkId: string, opts?: { json?: boolean }) => {
        const deleted = factsDb.deleteLink(linkId);
        if (opts?.json) {
          console.log(JSON.stringify({ linkId, deleted }, null, 2));
        } else if (deleted) {
          console.log(`Deleted link ${linkId}.`);
        } else {
          console.log(`No link found with id ${linkId} (nothing deleted).`);
        }
        if (!deleted) process.exitCode = 1;
      }),
    );
}
