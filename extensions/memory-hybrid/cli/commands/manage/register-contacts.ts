/**
 * CLI: structured contact profiles — import, sync, merge (#2014).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { capturePluginError } from "../../../services/error-reporter.js";
import {
  parseContactsFile,
  readContactsFileMtime,
  runContactsImport,
} from "../../../services/contact-profile.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

const CONTACTS_SYNC_STATE_KEY = "contacts_import_mtime";

function resolveImportPath(explicit: string | undefined, configured: string | null): string {
  if (explicit?.trim()) return explicit.trim();
  if (configured) return configured;
  return join(process.cwd(), "workspace", "CONTACTS.md");
}

export function registerContactsCommands(mem: Chainable, b: ManageBindings): void {
  const { factsDb, cfg } = b;
  const contactsCmd = mem.command("contacts").description("Import, sync, and merge structured contact profiles");

  contactsCmd
    .command("merge <canonical> <duplicate>")
    .description("Merge duplicate contact rows; reassign NER mentions and entity FKs to the canonical contact")
    .option("--json", "Emit JSON summary")
    .action(
      withExit(async (canonical: string, duplicate: string, opts?: { json?: boolean }) => {
        try {
          const summary = factsDb.mergeContacts(canonical, duplicate);
          if (opts?.json) {
            console.log(JSON.stringify(summary, null, 2));
            return;
          }
          console.log(
            `Merged "${duplicate}" into "${canonical}" (canonical id=${summary.canonicalId}). Mentions reassigned: ${summary.mentionsReassigned}, facts reassigned: ${summary.factsReassigned}.`,
          );
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "contacts-merge",
          });
          console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
      }),
    );

  contactsCmd
    .command("import")
    .description("Import CONTACTS.md into organizations, contacts, roster facts, and org_fact_links")
    .option("--from <path>", "Path to CONTACTS.md")
    .option("--embed", "Embed stored facts via the normal store embedding path (when CLI store supports it)")
    .option("--dry-run", "Parse and report counts without writing")
    .option("--no-part-of", "Skip PART_OF links from person facts to roster facts")
    .option("--json", "Emit JSON summary")
    .action(
      withExit(
        async (opts?: {
          from?: string;
          embed?: boolean;
          dryRun?: boolean;
          noPartOf?: boolean;
          json?: boolean;
        }) => {
          const path = resolveImportPath(opts?.from, cfg.contacts.importPath);
          if (!existsSync(path)) {
            console.error(`error: contacts file not found: ${path}`);
            process.exitCode = 1;
            return;
          }
          try {
            const sections = parseContactsFile(path);
            const result = runContactsImport(
              factsDb.getRawDb(),
              sections,
              {
                storeFact: (input) => {
                  const entry = factsDb.store({
                    text: input.text,
                    entity: input.entity,
                    category: input.category as "entity",
                    source: input.source,
                    importance: input.importance,
                  });
                  if (!entry.id) {
                    throw new Error("contacts import: fact store returned placeholder without id");
                  }
                  return entry;
                },
                createLink: (sourceId, targetId, linkType, strength) =>
                  factsDb.createLink(sourceId, targetId, linkType, strength),
              },
              { dryRun: opts?.dryRun === true, linkPartOf: opts?.noPartOf !== true },
            );
            if (!opts?.dryRun) {
              const mtime = readContactsFileMtime(path);
              if (mtime != null) {
                factsDb.getRawDb()
                  .prepare(
                    `INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
                  )
                  .run(CONTACTS_SYNC_STATE_KEY, String(mtime), Math.floor(Date.now() / 1000));
              }
            }
            if (opts?.json) {
              console.log(JSON.stringify({ path, sections: sections.length, ...result }, null, 2));
              return;
            }
            console.log(
              `${result.dryRun ? "Dry-run" : "Imported"} ${path}: orgs≈${result.organizationsUpserted}, contacts≈${result.contactsUpserted}, facts≈${result.factsStored}, org_links≈${result.orgLinksCreated}, part_of≈${result.partOfLinksCreated}.`,
            );
            if (opts?.embed) {
              console.log("Note: --embed relies on the plugin's async embedding pipeline for newly stored facts.");
            }
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "contacts-import",
            });
            console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
            process.exitCode = 1;
          }
        },
      ),
    );

  contactsCmd
    .command("sync")
    .description("Re-import CONTACTS.md when the file mtime changed since the last sync")
    .option("--from <path>", "Path to CONTACTS.md")
    .option("--embed", "Embed stored facts (same as import --embed)")
    .option("--dry-run", "Report whether sync would run without writing")
    .option("--force", "Import even when mtime unchanged")
    .option("--json", "Emit JSON summary")
    .action(
      withExit(
        async (opts?: {
          from?: string;
          embed?: boolean;
          dryRun?: boolean;
          force?: boolean;
          json?: boolean;
        }) => {
          const path = resolveImportPath(opts?.from, cfg.contacts.importPath);
          if (!existsSync(path)) {
            console.error(`error: contacts file not found: ${path}`);
            process.exitCode = 1;
            return;
          }
          const mtime = readContactsFileMtime(path);
          const prev = factsDb.getRawDb().prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(
            CONTACTS_SYNC_STATE_KEY,
          ) as { value: string } | undefined;
          const prevMtime = prev?.value ? Number(prev.value) : null;
          const unchanged = prevMtime != null && mtime != null && prevMtime === mtime;
          if (unchanged && opts?.force !== true) {
            const payload = { path, skipped: true, reason: "mtime_unchanged", mtime };
            if (opts?.json) {
              console.log(JSON.stringify(payload, null, 2));
              return;
            }
            console.log(`Contacts unchanged (${path}); skip sync. Use --force to re-import.`);
            return;
          }
          const sections = parseContactsFile(path);
          const result = runContactsImport(
            factsDb.getRawDb(),
            sections,
            {
              storeFact: (input) => {
                const entry = factsDb.store({
                  text: input.text,
                  entity: input.entity,
                  category: input.category as "entity",
                  source: input.source,
                  importance: input.importance,
                });
                if (!entry.id) {
                  throw new Error("contacts sync: fact store returned placeholder without id");
                }
                return entry;
              },
              createLink: (sourceId, targetId, linkType, strength) =>
                factsDb.createLink(sourceId, targetId, linkType, strength),
            },
            { dryRun: opts?.dryRun === true },
          );
          if (!opts?.dryRun && mtime != null) {
            factsDb.getRawDb()
              .prepare(
                `INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
              )
              .run(CONTACTS_SYNC_STATE_KEY, String(mtime), Math.floor(Date.now() / 1000));
          }
          if (opts?.json) {
            console.log(JSON.stringify({ path, skipped: false, sections: sections.length, ...result }, null, 2));
            return;
          }
          console.log(
            `${result.dryRun ? "Dry-run sync" : "Synced"} ${path}: orgs≈${result.organizationsUpserted}, contacts≈${result.contactsUpserted}, facts≈${result.factsStored}.`,
          );
          if (opts?.embed) {
            console.log("Note: --embed relies on the plugin's async embedding pipeline for newly stored facts.");
          }
        },
      ),
    );
}
