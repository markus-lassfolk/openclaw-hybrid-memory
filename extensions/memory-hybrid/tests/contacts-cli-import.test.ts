/**
 * `hybrid-mem contacts import`/`sync` CLI logic (issue #2014).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { runContactsImport } from "../cli/commands/manage/register-contacts.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import type { StoreCliOpts, StoreCliResult } from "../cli/types.js";

const ROSTER = `
## Avoki

- Daniel Thunberg | daniel.thunberg@avoki.com | Sverigechef | management
- Jane Doe | jane@avoki.com | | board
`;

describe("contacts import (#2014)", () => {
  let dir: string;
  let db: FactsDB;
  let rosterPath: string;
  let bindings: ManageBindings;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hybrid-contacts-import-"));
    mkdirSync(dir, { recursive: true });
    db = new FactsDB(join(dir, "facts.db"));
    rosterPath = join(dir, "CONTACTS.md");
    writeFileSync(rosterPath, ROSTER);

    const runStore = async (opts: StoreCliOpts): Promise<StoreCliResult> => {
      if (db.hasDuplicate(opts.text, "test", { category: opts.category, entity: opts.entity })) {
        return { outcome: "duplicate" };
      }
      const entry = db.store({
        text: opts.text,
        entity: opts.entity ?? null,
        key: opts.key ?? null,
        value: opts.value ?? null,
        category: "entity",
        importance: 0.5,
        source: "test",
      });
      return { outcome: "stored", id: entry.id, textPreview: entry.text.slice(0, 100) };
    };

    // Minimal ManageBindings stub — only the fields runContactsImport actually touches.
    bindings = { factsDb: db, runStore, resolvedSqlitePath: join(dir, "facts.db") } as unknown as ManageBindings;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("upserts orgs, contacts (with profile fields), and roster facts", async () => {
    const result = await runContactsImport(bindings, rosterPath, { dryRun: false });
    expect(result.orgsUpserted).toBe(1);
    expect(result.contactsUpserted).toBe(2);
    expect(result.contactsMerged).toBe(0);
    expect(result.factsStored).toBe(2);
    expect(result.factsSkipped).toBe(0);

    const org = db.lookupOrganization("Avoki");
    expect(org).not.toBeNull();
    const daniel = db.listContactsByNamePrefix("Daniel", 10)[0];
    expect(daniel.email).toBe("daniel.thunberg@avoki.com");
    expect(daniel.role).toBe("Sverigechef");
    expect(daniel.updatedBy).toBe("import");

    const jane = db.listContactsByNamePrefix("Jane", 10)[0];
    expect(jane.boardStatus).toBe("board");

    // memory_directory list_contacts / org_view rely on this link (#2014 acceptance criteria).
    if (!org) throw new Error("expected org");
    expect(db.listFactIdsLinkedToOrg(org.id, 10)).toHaveLength(2);
  });

  it("is idempotent: re-importing the same file does not create duplicate contacts or facts", async () => {
    const first = await runContactsImport(bindings, rosterPath, { dryRun: false });
    const second = await runContactsImport(bindings, rosterPath, { dryRun: false });

    expect(first.factsStored).toBe(2);
    expect(second.factsStored).toBe(0);
    expect(second.factsSkipped).toBe(2);
    expect(db.listContactsByNamePrefix("", 100)).toHaveLength(2);
  });

  it("dry-run does not write anything", async () => {
    const result = await runContactsImport(bindings, rosterPath, { dryRun: true });
    expect(result.orgsUpserted).toBe(1);
    expect(result.contactsUpserted).toBe(2);
    expect(db.listContactsByNamePrefix("", 100)).toHaveLength(0);
    expect(db.lookupOrganization("Avoki")).toBeNull();
  });
});
