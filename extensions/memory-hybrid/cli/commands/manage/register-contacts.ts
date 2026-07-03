/**
 * `hybrid-mem contacts` — structured contact profile enrichment CLI (issue #2014):
 * merge duplicate NER contacts, and import/sync a CONTACTS.md-style roster file.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ContactRow } from "../../../backends/facts-db/entity-layer.js";
import { parseContactsRoster } from "../../../services/contacts-roster.js";
import { withExit } from "../../shared.js";
import type { Chainable } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

export type ContactsImportResult = {
  orgsUpserted: number;
  contactsUpserted: number;
  contactsMerged: number;
  factsStored: number;
  factsSkipped: number;
  partOfLinksCreated: number;
};

/** Exported for tests (issue #2014). */
export async function runContactsImport(
  b: ManageBindings,
  filePath: string,
  opts: { dryRun: boolean; linkPartOf?: boolean },
): Promise<ContactsImportResult> {
  const { factsDb, runStore } = b;
  const linkPartOf = opts.linkPartOf !== false;
  const markdown = readFileSync(filePath, "utf-8");
  const orgs = parseContactsRoster(markdown);
  const result: ContactsImportResult = {
    orgsUpserted: 0,
    contactsUpserted: 0,
    contactsMerged: 0,
    factsStored: 0,
    factsSkipped: 0,
    partOfLinksCreated: 0,
  };

  for (const org of orgs) {
    if (opts.dryRun) {
      result.orgsUpserted++;
      result.contactsUpserted += org.people.length;
      continue;
    }
    const orgResult = factsDb.upsertOrganization(org.name);
    if (orgResult) result.orgsUpserted++;

    // Per-org summary roster fact (#2014): one searchable fact listing the whole roster, linked to
    // the org. Person roster facts below attach to it via PART_OF so graph traversal from a person
    // reaches the org roster. Only freshly-stored facts get an id (dedupe returns no id), which
    // keeps re-imports idempotent — no duplicate roster facts or PART_OF links on repeat runs.
    let orgRosterFactId: string | null = null;
    if (org.people.length > 0) {
      const rosterSummary = org.people
        .map((p) => [p.name, p.email, p.role].filter(Boolean).join(" — "))
        .join("; ");
      const orgRosterResult = await runStore({
        text: `${org.name} contacts: ${rosterSummary}`,
        category: "entity",
        entity: org.name,
        key: "roster",
        value: org.name,
      });
      if (orgRosterResult.outcome === "stored") {
        result.factsStored++;
        orgRosterFactId = orgRosterResult.id;
        if (orgResult) factsDb.linkFactToOrganization(orgResult.id, orgRosterResult.id, "roster_import");
      } else {
        result.factsSkipped++;
      }
    }

    for (const person of org.people) {
      const contactResult = factsDb.upsertContactWithProfile(person.name, orgResult?.id ?? null, {
        email: person.email,
        role: person.role,
        boardStatus: person.boardStatus,
        source: "import",
        updatedBy: "import",
      });
      if (contactResult) {
        result.contactsUpserted++;
        if (contactResult.mergedInto) result.contactsMerged++;
      }

      const rosterText =
        `${person.name} — ${org.name} roster entry` +
        (person.role ? ` — ${person.role}` : "") +
        (person.email ? ` — ${person.email}` : "");
      const storeResult = await runStore({
        text: rosterText,
        category: "entity",
        entity: person.name,
        key: "role",
        value: person.role ?? org.name,
      });
      if (storeResult.outcome === "stored") {
        result.factsStored++;
        if (orgResult) factsDb.linkFactToOrganization(orgResult.id, storeResult.id, "roster_import");
        // PART_OF: this person's roster fact belongs to the org's roster fact (#2014).
        if (linkPartOf && orgRosterFactId && orgRosterFactId !== storeResult.id) {
          factsDb.createLink(storeResult.id, orgRosterFactId, "PART_OF", 1.0);
          result.partOfLinksCreated++;
        }
      } else {
        result.factsSkipped++;
      }
    }
  }

  return result;
}

type ContactsSyncState = Record<string, number>;

function syncStatePath(b: ManageBindings): string {
  const dir = b.resolvedSqlitePath ? dirname(b.resolvedSqlitePath) : process.cwd();
  return join(dir, ".contacts-sync-state.json");
}

function readSyncState(path: string): ContactsSyncState {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as ContactsSyncState) : {};
  } catch {
    return {};
  }
}

function writeSyncState(path: string, state: ContactsSyncState): void {
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function formatImportSummary(prefix: string, filePath: string, result: ContactsImportResult): string {
  return (
    `${prefix} ${filePath}: ${result.orgsUpserted} org(s), ${result.contactsUpserted} contact(s) ` +
    `(${result.contactsMerged} merged), ${result.factsStored} roster fact(s) stored ` +
    `(${result.factsSkipped} skipped as duplicate), ${result.partOfLinksCreated} PART_OF link(s).`
  );
}

export function registerManageContacts(mem: Chainable, b: ManageBindings): void {
  const { factsDb } = b;
  const contacts = mem
    .command("contacts")
    .description("Structured contact profile enrichment: merge duplicates, import/sync a CONTACTS.md roster (#2014)");

  contacts
    .command("merge <fromId> <intoId>")
    .description(
      "Merge one contact into another (each arg accepts a contact id or a name): repoints NER mentions and fact FKs to intoId, folds in profile fields (manual wins conflicts), deletes fromId",
    )
    .action(
      withExit(async (fromArg: string, intoArg: string) => {
        const fromId = factsDb.resolveContactId(fromArg);
        const intoId = factsDb.resolveContactId(intoArg);
        if (!fromId) {
          console.error(`Merge failed: no contact matches "${fromArg}".`);
          process.exitCode = 1;
          return;
        }
        if (!intoId) {
          console.error(`Merge failed: no contact matches "${intoArg}".`);
          process.exitCode = 1;
          return;
        }
        const result = factsDb.mergeContacts(fromId, intoId);
        if (!result.ok) {
          console.error(`Merge failed: ${result.error}`);
          process.exitCode = 1;
          return;
        }
        console.log(
          `Merged contact ${fromId} into ${intoId} (repointed ${result.mergedFactMentions} mention${result.mergedFactMentions === 1 ? "" : "s"}).`,
        );
      }),
    );

  contacts
    .command("suggest-merges")
    .description("List contacts that look like partial-name duplicates of another contact (candidates for `contacts merge`)")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const all = factsDb.listContactsByNamePrefix("", 1000);
        const seen = new Set<string>();
        const suggestions: Array<{ from: ContactRow; into: ContactRow }> = [];
        for (const c of all) {
          if (seen.has(c.id)) continue;
          const candidates = factsDb.findContactMergeCandidates(c.normalizedKey, c.id);
          if (candidates.length === 1) {
            const other = candidates[0];
            const [shorter, longer] =
              c.normalizedKey.length < other.normalizedKey.length ? [c, other] : [other, c];
            if (!seen.has(shorter.id)) {
              suggestions.push({ from: shorter, into: longer });
              seen.add(shorter.id);
            }
          }
        }
        if (opts?.json) {
          console.log(
            JSON.stringify(
              suggestions.map((s) => ({
                from: s.from.id,
                fromName: s.from.displayName,
                into: s.into.id,
                intoName: s.into.displayName,
              })),
              null,
              2,
            ),
          );
          return;
        }
        if (suggestions.length === 0) {
          console.log("No merge candidates found.");
          return;
        }
        console.log(`Suggested merges (${suggestions.length}):`);
        for (const s of suggestions) {
          console.log(`  contacts merge ${s.from.id} ${s.into.id}   # "${s.from.displayName}" -> "${s.into.displayName}"`);
        }
      }),
    );

  contacts
    .command("list")
    .description("List contacts (id, name, role, org, email)")
    .option("--prefix <name>", "Filter by display name prefix")
    .option("--limit <n>", "Max rows (default 40)", "40")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { prefix?: string; limit?: string; json?: boolean }) => {
        const limit = Math.min(500, Math.max(1, Number.parseInt(opts?.limit ?? "40", 10) || 40));
        const rows = factsDb.listContactsByNamePrefix(opts?.prefix ?? "", limit);
        if (opts?.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        if (rows.length === 0) {
          console.log("No contacts found.");
          return;
        }
        console.log(`Contacts (${rows.length}):`);
        for (const c of rows) {
          const org = c.primaryOrgId ? factsDb.getOrganizationById(c.primaryOrgId) : null;
          console.log(
            `  [${c.id}] ${c.displayName}${c.role ? ` — ${c.role}` : ""}${org ? ` @ ${org.displayName}` : ""}${c.email ? ` <${c.email}>` : ""}`,
          );
        }
      }),
    );

  contacts
    .command("import")
    .description("Import/upsert organizations, contacts, and roster facts from a CONTACTS.md-style file (idempotent)")
    .option("--from <path>", "Path to the roster markdown file (defaults to contacts.importPath from config)")
    .option("--dry-run", "Preview counts without writing")
    .option(
      "--embed",
      "No-op: roster facts always go through the existing store path, which embeds them when an embedding provider is configured",
    )
    .option("--no-part-of", "Skip PART_OF links from person roster facts to the org roster fact")
    .action(
      withExit(async (opts: { from?: string; dryRun?: boolean; embed?: boolean; noPartOf?: boolean }) => {
        const fromPath = opts.from ?? b.cfg.contacts.importPath;
        if (!fromPath) {
          console.error("error: no roster file given; pass --from <path> or set contacts.importPath in config");
          process.exitCode = 1;
          return;
        }
        const filePath = resolve(fromPath);
        if (!existsSync(filePath)) {
          console.error(`error: file not found: ${filePath}`);
          process.exitCode = 1;
          return;
        }
        const result = await runContactsImport(b, filePath, {
          dryRun: opts.dryRun === true,
          linkPartOf: opts.noPartOf !== true,
        });
        console.log(formatImportSummary(opts.dryRun ? "Would import from" : "Imported from", filePath, result));
      }),
    );

  contacts
    .command("sync")
    .description("Re-run `contacts import` only if the roster file's mtime changed since the last sync")
    .option("--from <path>", "Path to the roster markdown file (defaults to contacts.importPath from config)")
    .option("--force", "Re-import even if the file has not changed")
    .action(
      withExit(async (opts: { from?: string; force?: boolean }) => {
        const fromPath = opts.from ?? b.cfg.contacts.importPath;
        if (!fromPath) {
          console.error("error: no roster file given; pass --from <path> or set contacts.importPath in config");
          process.exitCode = 1;
          return;
        }
        const filePath = resolve(fromPath);
        if (!existsSync(filePath)) {
          console.error(`error: file not found: ${filePath}`);
          process.exitCode = 1;
          return;
        }
        const mtimeMs = statSync(filePath).mtimeMs;
        const statePath = syncStatePath(b);
        const state = readSyncState(statePath);
        if (!opts.force && state[filePath] === mtimeMs) {
          console.log(`Up to date: ${filePath} has not changed since the last sync.`);
          return;
        }
        const result = await runContactsImport(b, filePath, { dryRun: false });
        state[filePath] = mtimeMs;
        writeSyncState(statePath, state);
        console.log(formatImportSummary("Synced", filePath, result));
      }),
    );
}
