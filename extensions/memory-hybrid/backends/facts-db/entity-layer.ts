/**
 * Organizations, contacts, and NER mention persistence (#985–#987).
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalizeEntityMention, countReason, makeEntityMentionKey } from "../../utils/entity-mention-quality.js";
import { isEntityStopWord, normalizeEntityStopWord } from "../../utils/entity-stopwords.js";
import { parseContactProfileHints, type ContactProfileHints } from "../../utils/contact-profile-patterns.js";
import { createTransaction } from "../../utils/sqlite-transaction.js";
import { readSchemaVersion, runVersionedSchemaMigration } from "../sqlite-schema-meta.js";

export type EntityMentionLabel =
  | "PERSON"
  | "ORG"
  | "SERVICE"
  | "TOOL"
  | "MODEL"
  | "PROJECT"
  | "AGENT"
  | "ROLE"
  | "PRODUCT"
  | "LOCATION";

type _FactEntityMentionRow = {
  id: string;
  factId: string;
  label: EntityMentionLabel;
  surfaceText: string;
  normalizedSurface: string;
  startOffset: number;
  endOffset: number;
  confidence: number;
  detectedLang: string | null;
  source: string;
  contactId: string | null;
  organizationId: string | null;
};

export type OrganizationRow = {
  id: string;
  canonicalKey: string;
  displayName: string;
  aliasesJson: string | null;
};

/** Who last wrote profile fields on a contact — used to arbitrate conflicting merges (#2014). */
export type ContactUpdatedBy = "ner" | "import" | "agent" | "manual";

export type ContactRow = {
  id: string;
  normalizedKey: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  role: string | null;
  boardStatus: string | null;
  notes: string | null;
  aliasesJson: string | null;
  primaryOrgId: string | null;
  source: string | null;
  sourceDate: number | null;
  updatedBy: string | null;
  updatedAt: number;
};

export type EntityEnrichmentBacklogByTier = {
  hot: number;
  warm: number;
  structural: number;
  cold: number;
  unknown: number;
};

export type EntityEnrichmentBacklogSummary = {
  total: number;
  byTier: EntityEnrichmentBacklogByTier;
};

export type ListFactsNeedingEnrichmentOptions = {
  /** Process full backlog (no LIMIT) for manual one-shot catch-up mode. */
  all?: boolean;
};

export type EntityMentionsAuditSummary = {
  factsScanned: number;
  rowsScanned: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  reclassified: number;
  rejectReasons: Record<string, number>;
};

export type EntityMentionsCleanupSummary = EntityMentionsAuditSummary & {
  changedFacts: number;
  removedRows: number;
};

export function normalizeEntityKey(name: string): string {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

const MIN_ENTITY_MENTION_LENGTH = 3;
const NON_ORG_SERVICE_TERMS = new Set(["signal", "telegram", "whatsapp"]);
const NON_ENTITY_ORG_TERMS = new Set(["hybrid memory plugin", "the agent", "the system"]);
const PERSON_ROLE_TITLES = new Set(["architect", "developer", "director", "engineer", "manager", "surgeon"]);
const KNOWN_TWO_CHAR_MENTIONS = new Set(["gh", "jq", "ha"]);

function normalizeMentionSurfaceText(surfaceText: string): string {
  return surfaceText.trim();
}

function isValidTwoCharacterMention(mention: { label: EntityMentionLabel; surfaceText: string }): boolean {
  const surface = mention.surfaceText.trim();
  if (surface.length !== 2) {
    return false;
  }

  if (KNOWN_TWO_CHAR_MENTIONS.has(surface.toLowerCase())) {
    return true;
  }

  if (mention.label === "PERSON") {
    return /^\p{L}{2}$/u.test(surface);
  }

  if (!/^[\p{L}\p{N}]{2}$/u.test(surface)) {
    return false;
  }

  if (/\p{N}/u.test(surface) || /\p{Lu}/u.test(surface)) {
    return true;
  }

  // Allow two-character org mentions in scripts without uppercase variants (e.g. Han).
  return /\P{Script=Latin}/u.test(surface);
}

function shouldFilterEntityMention(mention: {
  label: EntityMentionLabel;
  surfaceText: string;
  normalizedSurface: string;
}): boolean {
  if (
    mention.surfaceText.length < MIN_ENTITY_MENTION_LENGTH &&
    !isValidTwoCharacterMention({ label: mention.label, surfaceText: mention.surfaceText })
  ) {
    return true;
  }

  if (isEntityStopWord(mention.surfaceText)) {
    return true;
  }

  const stopWordKey = normalizeEntityStopWord(mention.surfaceText);
  if (mention.label === "ORG") {
    return NON_ORG_SERVICE_TERMS.has(stopWordKey) || NON_ENTITY_ORG_TERMS.has(stopWordKey);
  }

  if (!mention.normalizedSurface.includes(" ") && PERSON_ROLE_TITLES.has(stopWordKey)) {
    return true;
  }

  return false;
}

function isContainedByLongerMention(
  mention: { label: EntityMentionLabel; normalizedSurface: string; startOffset: number; endOffset: number },
  other: { label: EntityMentionLabel; normalizedSurface: string; startOffset: number; endOffset: number },
): boolean {
  if (mention.label !== other.label || mention.normalizedSurface === other.normalizedSurface) {
    return false;
  }

  if (other.normalizedSurface.length <= mention.normalizedSurface.length) {
    return false;
  }

  // Check if spans overlap: they must overlap for containment to apply
  const spansOverlap = mention.startOffset < other.endOffset && other.startOffset < mention.endOffset;
  if (!spansOverlap) {
    return false;
  }

  const isWordBoundary = (char: string): boolean => {
    return char === " " || /[,\-.\/()\[\]{}:;!?'"&]/.test(char);
  };

  let searchStart = 0;
  while (searchStart <= other.normalizedSurface.length - mention.normalizedSurface.length) {
    const index = other.normalizedSurface.indexOf(mention.normalizedSurface, searchStart);
    if (index === -1) {
      return false;
    }

    const endIndex = index + mention.normalizedSurface.length;
    const beforeChar = index > 0 ? other.normalizedSurface[index - 1] : " ";
    const afterChar = endIndex < other.normalizedSurface.length ? other.normalizedSurface[endIndex] : " ";

    if (isWordBoundary(beforeChar) && (isWordBoundary(afterChar) || endIndex === other.normalizedSurface.length)) {
      return true;
    }

    searchStart = index + 1;
  }

  return false;
}

function preferEntityMention<
  T extends {
    confidence: number;
    surfaceText: string;
    startOffset: number;
  },
>(left: T, right: T): T {
  if (right.confidence !== left.confidence) {
    return right.confidence > left.confidence ? right : left;
  }
  if (right.surfaceText.length !== left.surfaceText.length) {
    return right.surfaceText.length > left.surfaceText.length ? right : left;
  }
  return right.startOffset < left.startOffset ? right : left;
}

export function normalizeFactEntityMentionsForPersistence<
  T extends {
    label: EntityMentionLabel;
    surfaceText: string;
    normalizedSurface: string;
    startOffset: number;
    endOffset: number;
    confidence: number;
  },
>(mentions: readonly T[]): T[] {
  const prepared = mentions
    .map((mention) => {
      const surfaceText = normalizeMentionSurfaceText(mention.surfaceText);
      const normalizedSurface = normalizeEntityKey(mention.normalizedSurface) || normalizeEntityKey(surfaceText);
      // Adjust offsets for trimmed whitespace so stored offsets match the trimmed surfaceText in the original fact text
      const leadingTrim = mention.surfaceText.length - mention.surfaceText.trimStart().length;
      const trailingTrim = mention.surfaceText.length - mention.surfaceText.trimEnd().length;
      return {
        ...mention,
        surfaceText,
        normalizedSurface,
        startOffset: mention.startOffset + leadingTrim,
        endOffset: mention.endOffset - trailingTrim,
      };
    })
    .filter((mention) => mention.surfaceText.length > 0 && mention.normalizedSurface.length > 0)
    .filter((mention) => !shouldFilterEntityMention(mention))
    .filter(
      (mention, index, all) =>
        !all.some((other, otherIndex) => otherIndex !== index && isContainedByLongerMention(mention, other)),
    );

  const deduplicated = new Map<string, T>();
  for (const mention of prepared) {
    // Use surfaceText for the dedup key so it matches what upsertOrganization/upsertContact compute for canonical_key
    const key = `${mention.label}\u0000${normalizeEntityKey(mention.surfaceText)}`;
    const existing = deduplicated.get(key);
    deduplicated.set(key, existing ? preferEntityMention(existing, mention) : mention);
  }

  return [...deduplicated.values()].sort((left, right) => left.startOffset - right.startOffset);
}

/** Escape `%`, `_`, and `\` for SQLite `LIKE ... ESCAPE '\'` literal matching. */
export function escapeLikeLiteralForBackslashEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function migrateEntityLayerTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      canonical_key TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      aliases_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_org_canonical ON organizations(canonical_key);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      normalized_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      mobile TEXT,
      role TEXT,
      board_status TEXT,
      notes TEXT,
      aliases_json TEXT,
      primary_org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
      source TEXT,
      source_date INTEGER,
      updated_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_org ON contacts(primary_org_id);
  `);
  // One row per normalized display key (upsertContact assumes uniqueness).
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_normalized_key_unique ON contacts(normalized_key)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_entity_mentions (
      id TEXT PRIMARY KEY,
      fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      surface_text TEXT NOT NULL,
      normalized_surface TEXT NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.8,
      detected_lang TEXT,
      source TEXT NOT NULL DEFAULT 'llm',
      contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
      organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fem_fact ON fact_entity_mentions(fact_id);
    CREATE INDEX IF NOT EXISTS idx_fem_org ON fact_entity_mentions(organization_id);
    CREATE INDEX IF NOT EXISTS idx_fem_contact ON fact_entity_mentions(contact_id);
    CREATE INDEX IF NOT EXISTS idx_fem_label ON fact_entity_mentions(label);
  `);

  const version = readSchemaVersion(db, "entity_layer");
  if (version < 1) {
    runVersionedSchemaMigration(db, "entity_layer", 1, () => {
      const hasDuplicates = db
        .prepare(
          `SELECT 1
           FROM fact_entity_mentions
           GROUP BY fact_id, label, normalized_surface
           HAVING COUNT(*) > 1
           LIMIT 1`,
        )
        .get() as { 1: number } | undefined;
      if (hasDuplicates) {
        db.exec(`
          DELETE FROM fact_entity_mentions
          WHERE id IN (
            SELECT m1.id
            FROM fact_entity_mentions m1
            JOIN fact_entity_mentions m2
              ON m1.fact_id = m2.fact_id
             AND m1.label = m2.label
             AND m1.normalized_surface = m2.normalized_surface
             AND (
                  m2.confidence > m1.confidence
               OR (m2.confidence = m1.confidence AND m2.created_at > m1.created_at)
               OR (m2.confidence = m1.confidence AND m2.created_at = m1.created_at AND m2.id > m1.id)
             )
          );
        `);
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fem_fact_label_norm
        ON fact_entity_mentions(fact_id, label, normalized_surface);
      `);
    });
  }

  // Contact profile enrichment columns (#2014): fresh installs get them from CREATE TABLE above;
  // existing DBs need ALTER TABLE. Re-read the version since the v1 block above may have just run.
  const version2 = readSchemaVersion(db, "entity_layer");
  if (version2 < 2) {
    runVersionedSchemaMigration(db, "entity_layer", 2, () => {
      const cols = db.prepare("PRAGMA table_info(contacts)").all() as Array<{ name: string }>;
      const colNames = new Set(cols.map((c) => c.name));
      const addColumnIfMissing = (name: string, ddl: string) => {
        if (!colNames.has(name)) db.exec(`ALTER TABLE contacts ADD COLUMN ${ddl}`);
      };
      addColumnIfMissing("phone", "phone TEXT");
      addColumnIfMissing("mobile", "mobile TEXT");
      addColumnIfMissing("role", "role TEXT");
      addColumnIfMissing("board_status", "board_status TEXT");
      addColumnIfMissing("source", "source TEXT");
      addColumnIfMissing("source_date", "source_date INTEGER");
      addColumnIfMissing("updated_by", "updated_by TEXT");
    });
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS org_fact_links (
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      reason TEXT NOT NULL DEFAULT 'ner_mention',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, fact_id, reason)
    );
    CREATE INDEX IF NOT EXISTS idx_org_fact_org ON org_fact_links(org_id);
    CREATE INDEX IF NOT EXISTS idx_org_fact_fact ON org_fact_links(fact_id);
  `);
}

/** Exported for `contacts import` (issue #2014), which upserts organizations from a roster file. */
export function upsertOrganization(db: DatabaseSync, displayName: string): { id: string; created: boolean } | null {
  const canonicalKey = normalizeEntityKey(displayName);
  if (!canonicalKey) {
    return null;
  }
  const existing = db.prepare("SELECT id FROM organizations WHERE canonical_key = ?").get(canonicalKey) as
    | { id: string }
    | undefined;
  if (existing) {
    const now = Math.floor(Date.now() / 1000);
    db.prepare("UPDATE organizations SET display_name = ?, updated_at = ? WHERE id = ?").run(
      displayName.trim(),
      now,
      existing.id,
    );
    return { id: existing.id, created: false };
  }
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO organizations (id, canonical_key, display_name, aliases_json, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  ).run(id, canonicalKey, displayName.trim(), now, now);
  return { id, created: true };
}

export type UpsertContactOptions = ContactProfileFieldUpdate & {
  /**
   * When true (default), auto-merge into a single unambiguous existing contact whose
   * normalized_key is a token prefix/suffix of the new name — instead of creating a duplicate
   * row — when no exact normalized_key match exists (issue #2014). Ambiguous (0 or 2+
   * candidates) always falls through to creating a new contact.
   */
  autoMerge?: boolean;
};

function mergeAliasesForRename(
  aliasesJson: string | null,
  keptDisplayName: string,
  droppedDisplayName: string,
): string {
  const aliasSet = new Set<string>();
  if (aliasesJson) {
    try {
      const parsed = JSON.parse(aliasesJson);
      if (Array.isArray(parsed)) {
        for (const a of parsed) if (typeof a === "string") aliasSet.add(a);
      }
    } catch {
      /* ignore malformed aliases_json */
    }
  }
  aliasSet.add(droppedDisplayName);
  aliasSet.delete(keptDisplayName);
  return JSON.stringify([...aliasSet]);
}

/** Exported for `contacts import` (issue #2014), which upserts contacts with profile fields from a roster file. */
export function upsertContact(
  db: DatabaseSync,
  displayName: string,
  primaryOrgId: string | null,
  options: UpsertContactOptions = {},
): { id: string; created: boolean; mergedInto?: string } | null {
  const nk = normalizeEntityKey(displayName);
  if (!nk) {
    return null;
  }
  const existing = db.prepare("SELECT id, primary_org_id FROM contacts WHERE normalized_key = ? LIMIT 1").get(nk) as
    | { id: string; primary_org_id: string | null }
    | undefined;
  const now = Math.floor(Date.now() / 1000);
  if (existing) {
    if (primaryOrgId && !existing.primary_org_id) {
      db.prepare("UPDATE contacts SET primary_org_id = ?, updated_at = ?, display_name = ? WHERE id = ?").run(
        primaryOrgId,
        now,
        displayName.trim(),
        existing.id,
      );
    } else {
      db.prepare("UPDATE contacts SET updated_at = ?, display_name = ? WHERE id = ?").run(
        now,
        displayName.trim(),
        existing.id,
      );
    }
    applyContactProfileFields(db, existing.id, options);
    return { id: existing.id, created: false };
  }

  if (options.autoMerge !== false) {
    const candidates = findContactMergeCandidates(db, nk);
    if (candidates.length === 1) {
      const target = candidates[0];
      const newIsLonger = nk.length > target.normalizedKey.length;
      const nextDisplayName = newIsLonger ? displayName.trim() : target.displayName;
      const droppedDisplayName = newIsLonger ? target.displayName : displayName.trim();
      const nextAliasesJson = mergeAliasesForRename(target.aliasesJson, nextDisplayName, droppedDisplayName);
      db.prepare(
        "UPDATE contacts SET display_name = ?, normalized_key = ?, primary_org_id = COALESCE(?, primary_org_id), aliases_json = ?, updated_at = ? WHERE id = ?",
      ).run(nextDisplayName, normalizeEntityKey(nextDisplayName), primaryOrgId, nextAliasesJson, now, target.id);
      applyContactProfileFields(db, target.id, options);
      return { id: target.id, created: false, mergedInto: target.id };
    }
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO contacts (
       id, normalized_key, display_name, email, phone, mobile, role, board_status, notes,
       aliases_json, primary_org_id, source, source_date, updated_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    nk,
    displayName.trim(),
    options.email ?? null,
    options.phone ?? null,
    options.mobile ?? null,
    options.role ?? null,
    options.boardStatus ?? null,
    options.notes ?? null,
    primaryOrgId,
    options.source ?? null,
    options.source ? now : null,
    options.updatedBy ?? null,
    now,
    now,
  );
  return { id, created: true };
}

/**
 * Explicitly merge one contact into another (issue #2014 — `contacts merge` CLI): repoints
 * `fact_entity_mentions.contact_id`, folds in profile fields (manual priority) and aliases, then
 * deletes the source row. Manual merges always win field conflicts (source: "manual").
 */
export function mergeContacts(
  db: DatabaseSync,
  fromId: string,
  intoId: string,
): { ok: true; mergedFactMentions: number } | { ok: false; error: string } {
  if (fromId === intoId) {
    return { ok: false, error: "Cannot merge a contact into itself." };
  }
  const from = getContactById(db, fromId);
  const into = getContactById(db, intoId);
  if (!from) return { ok: false, error: `Contact ${fromId} not found.` };
  if (!into) return { ok: false, error: `Contact ${intoId} not found.` };

  const tx = createTransaction(db, () => {
    const now = Math.floor(Date.now() / 1000);
    const nextAliasesJson = mergeAliasesForRename(into.aliasesJson, into.displayName, from.displayName);
    applyContactProfileFields(db, intoId, {
      email: from.email,
      phone: from.phone,
      mobile: from.mobile,
      role: from.role,
      boardStatus: from.boardStatus,
      notes: from.notes,
      source: "manual",
      updatedBy: "manual",
    });
    db.prepare(
      "UPDATE contacts SET aliases_json = ?, primary_org_id = COALESCE(primary_org_id, ?), updated_at = ? WHERE id = ?",
    ).run(nextAliasesJson, from.primaryOrgId, now, intoId);
    const mentionsRes = db
      .prepare("UPDATE fact_entity_mentions SET contact_id = ? WHERE contact_id = ?")
      .run(intoId, fromId);
    // Repoint resolved fact→contact FKs before deleting the source row, otherwise any fact whose
    // entity_contact_id still points at the merged-away contact is left dangling (the column has no
    // ON DELETE cascade). See facts-db entity_contact_id writers (#2014).
    db.prepare("UPDATE facts SET entity_contact_id = ? WHERE entity_contact_id = ?").run(intoId, fromId);
    db.prepare("DELETE FROM contacts WHERE id = ?").run(fromId);
    return { mergedFactMentions: Number(mentionsRes.changes ?? 0) };
  });
  const result = tx();
  return { ok: true, mergedFactMentions: result.mergedFactMentions };
}

export function replaceFactEntityMentions(
  db: DatabaseSync,
  factId: string,
  mentions: Array<{
    label: EntityMentionLabel;
    surfaceText: string;
    normalizedSurface: string;
    startOffset: number;
    endOffset: number;
    confidence: number;
    detectedLang: string | null;
    source: string;
  }>,
  options: { preserveEnrichmentTimestamp?: boolean; requireSurnameForNewContacts?: boolean } = {},
): void {
  const tx = createTransaction(db, () => {
    db.prepare("DELETE FROM fact_entity_mentions WHERE fact_id = ?").run(factId);
    db.prepare("DELETE FROM org_fact_links WHERE fact_id = ? AND reason = 'ner_mention'").run(factId);
    const normalizedMentions = normalizeFactEntityMentionsForPersistence(mentions);
    // Issue #2014: gate new single-token PERSON contacts (no surname) unless the fact also has org context.
    const hasOrgMention = normalizedMentions.some((m) => m.label === "ORG");
    const hasSurname = (surface: string) => surface.trim().split(/\s+/).filter(Boolean).length >= 2;

    const now = Math.floor(Date.now() / 1000);
    // Intentional OR IGNORE: idx_fem_fact_label_norm enforces idempotent logical mention writes.
    const ins = db.prepare(
      `INSERT OR IGNORE INTO fact_entity_mentions (
        id, fact_id, label, surface_text, normalized_surface, start_offset, end_offset,
        confidence, detected_lang, source, contact_id, organization_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insOrgLink = db.prepare(
      `INSERT OR IGNORE INTO org_fact_links (org_id, fact_id, reason, created_at) VALUES (?, ?, 'ner_mention', ?)`,
    );

    const orgIds: string[] = [];
    const personRows: Array<{ surface: string; contactId: string }> = [];

    for (const m of normalizedMentions) {
      let contactId: string | null = null;
      let organizationId: string | null = null;

      if (m.label === "ORG") {
        const org = upsertOrganization(db, m.surfaceText);
        if (org) {
          organizationId = org.id;
          orgIds.push(org.id);
          insOrgLink.run(org.id, factId, now);
        }
      } else if (m.label === "PERSON") {
        const allowNewContact = options.requireSurnameForNewContacts !== true || hasSurname(m.surfaceText) || hasOrgMention;
        const con = allowNewContact ? upsertContact(db, m.surfaceText, null, { source: "ner", updatedBy: "ner" }) : null;
        if (con) {
          contactId = con.id;
          personRows.push({ surface: m.surfaceText, contactId: con.id });
        }
      }

      ins.run(
        randomUUID(),
        factId,
        m.label,
        m.surfaceText,
        m.normalizedSurface,
        m.startOffset,
        m.endOffset,
        m.confidence,
        m.detectedLang,
        m.source,
        contactId,
        organizationId,
        now,
      );
    }

    // If same fact mentions both a person and an org, set primary_org on contacts (weak v1 heuristic).
    if (orgIds.length > 0 && personRows.length > 0) {
      const primaryOrg = orgIds[0];
      for (const p of personRows) {
        db.prepare("UPDATE contacts SET primary_org_id = COALESCE(primary_org_id, ?), updated_at = ? WHERE id = ?").run(
          primaryOrg,
          now,
          p.contactId,
        );
      }
    }

    if (!options.preserveEnrichmentTimestamp) {
      db.prepare("UPDATE facts SET entity_enrichment_at = ? WHERE id = ?").run(now, factId);
    }
  });
  tx();
}

export type ContactProfileEnrichmentSource = ContactUpdatedBy;

export type ContactProfileEnrichmentResult = {
  contactId: string;
  hints: ContactProfileHints;
};

/**
 * Parse email/phone/role/board-status hints from fact text and merge them onto the single PERSON
 * contact mentioned in the fact (issue #2014: "structured contact profile enrichment"). No-ops
 * when the fact mentions zero or multiple people — attributing hints to the wrong person is worse
 * than not enriching — or when nothing was parsed from the text.
 */
export function applyContactProfileEnrichmentForFact(
  db: DatabaseSync,
  factId: string,
  factText: string,
  source: ContactProfileEnrichmentSource,
): ContactProfileEnrichmentResult | null {
  const personRows = db
    .prepare(
      `SELECT DISTINCT contact_id FROM fact_entity_mentions
       WHERE fact_id = ? AND label = 'PERSON' AND contact_id IS NOT NULL`,
    )
    .all(factId) as Array<{ contact_id: string }>;
  if (personRows.length !== 1) return null;

  const hints = parseContactProfileHints(factText);
  if (!hints.email && !hints.phone && !hints.role) return null;

  const contactId = personRows[0].contact_id;
  applyContactProfileFields(db, contactId, {
    email: hints.email,
    phone: hints.phone,
    role: hints.role,
    boardStatus: hints.boardStatus,
    source,
    updatedBy: source,
  });
  return { contactId, hints };
}

export function getOrganizationByKeyOrName(db: DatabaseSync, query: string): OrganizationRow | null {
  const nk = normalizeEntityKey(query);
  if (!nk) return null;
  const byKey = db.prepare("SELECT * FROM organizations WHERE canonical_key = ?").get(nk) as
    | Record<string, unknown>
    | undefined;
  if (byKey) return rowToOrg(byKey);
  const like = `%${escapeLikeLiteralForBackslashEscape(nk)}%`;
  const byName = db
    .prepare(
      "SELECT * FROM organizations WHERE canonical_key LIKE ? ESCAPE '\\' ORDER BY length(display_name) ASC LIMIT 1",
    )
    .get(like) as Record<string, unknown> | undefined;
  return byName ? rowToOrg(byName) : null;
}

export function getOrganizationById(db: DatabaseSync, id: string): OrganizationRow | null {
  const row = db.prepare("SELECT * FROM organizations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToOrg(row) : null;
}

function rowToOrg(row: Record<string, unknown>): OrganizationRow {
  return {
    id: row.id as string,
    canonicalKey: row.canonical_key as string,
    displayName: row.display_name as string,
    aliasesJson: (row.aliases_json as string | null) ?? null,
  };
}

export function listContactsForOrg(db: DatabaseSync, orgId: string, limit: number): ContactRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM contacts
       WHERE primary_org_id = ?
       ORDER BY display_name COLLATE NOCASE
       LIMIT ?`,
    )
    .all(orgId, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToContact);
}

export function listContactsByNamePrefix(db: DatabaseSync, prefix: string, limit: number): ContactRow[] {
  const p = prefix.trim().toLowerCase();
  if (!p) {
    const rows = db.prepare("SELECT * FROM contacts ORDER BY display_name COLLATE NOCASE LIMIT ?").all(limit) as Array<
      Record<string, unknown>
    >;
    return rows.map(rowToContact);
  }
  const esc = escapeLikeLiteralForBackslashEscape(p);
  const pat = `${esc}%`;
  const normalizedPrefix = normalizeEntityKey(prefix);
  const escNormalized = escapeLikeLiteralForBackslashEscape(normalizedPrefix);
  const patNormalized = `${escNormalized}%`;
  const rows = db
    .prepare(
      `SELECT * FROM contacts
       WHERE lower(display_name) LIKE ? ESCAPE '\\' OR normalized_key LIKE ? ESCAPE '\\'
       ORDER BY display_name COLLATE NOCASE
       LIMIT ?`,
    )
    .all(pat, patNormalized, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToContact);
}

function rowToContact(row: Record<string, unknown>): ContactRow {
  return {
    id: row.id as string,
    normalizedKey: row.normalized_key as string,
    displayName: row.display_name as string,
    email: (row.email as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    mobile: (row.mobile as string | null) ?? null,
    role: (row.role as string | null) ?? null,
    boardStatus: (row.board_status as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    aliasesJson: (row.aliases_json as string | null) ?? null,
    primaryOrgId: (row.primary_org_id as string | null) ?? null,
    source: (row.source as string | null) ?? null,
    sourceDate: (row.source_date as number | null) ?? null,
    updatedBy: (row.updated_by as string | null) ?? null,
    updatedAt: row.updated_at as number,
  };
}

export function getContactById(db: DatabaseSync, id: string): ContactRow | null {
  const row = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToContact(row) : null;
}

/** Priority order for arbitrating conflicting profile-field writes (#2014): higher wins ties. */
const CONTACT_SOURCE_PRIORITY: Record<string, number> = { manual: 3, agent: 2, import: 2, ner: 1 };

function contactSourcePriority(updatedBy: string | null | undefined): number {
  return CONTACT_SOURCE_PRIORITY[updatedBy ?? ""] ?? 0;
}

export type ContactProfileFieldUpdate = {
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  role?: string | null;
  boardStatus?: string | null;
  /** Appended as a new line (deduped), never replaces existing notes. */
  notes?: string | null;
  source?: string | null;
  updatedBy?: ContactUpdatedBy | null;
};

/**
 * Merge profile fields onto an existing contact: fills empty fields unconditionally, and only
 * overwrites already-populated fields when the incoming source has >= priority of the current one
 * (manual > agent/import > ner). Notes are appended (deduplicated), never overwritten.
 */
function applyContactProfileFields(db: DatabaseSync, contactId: string, fields: ContactProfileFieldUpdate): void {
  const hasUpdate =
    fields.email != null ||
    fields.phone != null ||
    fields.mobile != null ||
    fields.role != null ||
    fields.boardStatus != null ||
    fields.notes != null;
  if (!hasUpdate) return;

  const row = db
    .prepare("SELECT email, phone, mobile, role, board_status, notes, updated_by FROM contacts WHERE id = ?")
    .get(contactId) as
    | {
        email: string | null;
        phone: string | null;
        mobile: string | null;
        role: string | null;
        board_status: string | null;
        notes: string | null;
        updated_by: string | null;
      }
    | undefined;
  if (!row) return;

  const canOverwrite = contactSourcePriority(fields.updatedBy) >= contactSourcePriority(row.updated_by);
  const pick = (current: string | null, incoming: string | null | undefined): string | null =>
    !current || (canOverwrite && incoming != null) ? (incoming ?? current) : current;

  const nextEmail = pick(row.email, fields.email);
  const nextPhone = pick(row.phone, fields.phone);
  const nextMobile = pick(row.mobile, fields.mobile);
  const nextRole = pick(row.role, fields.role);
  const nextBoardStatus = pick(row.board_status, fields.boardStatus);

  let nextNotes = row.notes;
  const noteLine = fields.notes?.trim();
  if (noteLine) {
    const existingLines = (row.notes ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    if (!existingLines.includes(noteLine)) {
      nextNotes = [...existingLines, noteLine].join("\n");
    }
  }

  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE contacts SET email = ?, phone = ?, mobile = ?, role = ?, board_status = ?, notes = ?,
       source = COALESCE(?, source), source_date = ?, updated_by = COALESCE(?, updated_by), updated_at = ?
     WHERE id = ?`,
  ).run(nextEmail, nextPhone, nextMobile, nextRole, nextBoardStatus, nextNotes, fields.source ?? null, now, fields.updatedBy ?? null, now, contactId);
}

/** True when one name's tokens are a contiguous prefix or suffix run of the other's (#2014). */
function isTokenPrefixOrSuffix(a: string, b: string): boolean {
  const at = a.split(" ").filter(Boolean);
  const bt = b.split(" ").filter(Boolean);
  if (at.length === 0 || bt.length === 0 || at.length === bt.length) return false;
  const [shorter, longer] = at.length < bt.length ? [at, bt] : [bt, at];
  const isPrefix = shorter.every((tok, i) => longer[i] === tok);
  const isSuffix = shorter.every((tok, i) => longer[longer.length - shorter.length + i] === tok);
  return isPrefix || isSuffix;
}

/**
 * Find existing contacts whose normalized_key is a token prefix/suffix of `normalizedKey` (or vice
 * versa) — candidates for auto-merge when NER creates a partial-name duplicate (e.g. "Daniel" vs.
 * "Daniel Thunberg"). Exported for `contacts merge --suggest` (#2014).
 */
export function findContactMergeCandidates(db: DatabaseSync, normalizedKey: string, excludeId?: string): ContactRow[] {
  const rows = (
    excludeId
      ? db.prepare("SELECT * FROM contacts WHERE id != ?").all(excludeId)
      : db.prepare("SELECT * FROM contacts").all()
  ) as Array<Record<string, unknown>>;
  return rows
    .filter((row) => isTokenPrefixOrSuffix(normalizedKey, row.normalized_key as string))
    .map(rowToContact);
}

export function listFactIdsForOrg(db: DatabaseSync, orgId: string, limit: number): string[] {
  const rows = db
    .prepare("SELECT DISTINCT fact_id FROM org_fact_links WHERE org_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(orgId, limit) as Array<{ fact_id: string }>;
  return rows.map((r) => r.fact_id);
}

function buildEntityEnrichmentPendingBaseSql(): string {
  return `SELECT f.id FROM facts f
      WHERE f.superseded_at IS NULL
        AND (f.expires_at IS NULL OR f.expires_at > ?)
        AND length(f.text) >= ?
        AND f.entity_enrichment_at IS NULL
      ORDER BY
        CASE COALESCE(f.tier, 'warm')
          WHEN 'hot' THEN 0
          WHEN 'warm' THEN 1
          WHEN 'structural' THEN 2
          WHEN 'cold' THEN 3
          ELSE 4
        END ASC,
        (COALESCE(f.out_degree, 0) + COALESCE(f.in_degree, 0)) DESC,
        COALESCE(f.last_accessed, f.last_confirmed_at, f.created_at) DESC,
        MAX(COALESCE(f.recall_count, 0), COALESCE(f.access_count, 0)) DESC,
        COALESCE(f.importance, 0) DESC,
        f.created_at DESC,
        f.id ASC`;
}

export function listFactsNeedingEnrichment(
  db: DatabaseSync,
  limit: number,
  minTextLen: number,
  options?: ListFactsNeedingEnrichmentOptions,
): string[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const sql = options?.all
    ? buildEntityEnrichmentPendingBaseSql()
    : `${buildEntityEnrichmentPendingBaseSql()}\n      LIMIT ?`;
  const rows = (
    options?.all ? db.prepare(sql).all(nowSec, minTextLen) : db.prepare(sql).all(nowSec, minTextLen, limit)
  ) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function getEntityEnrichmentBacklogSummary(
  db: DatabaseSync,
  minTextLen: number,
): EntityEnrichmentBacklogSummary {
  const nowSec = Math.floor(Date.now() / 1000);
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN COALESCE(f.tier, 'warm') = 'hot' THEN 1 ELSE 0 END) AS hot,
         SUM(CASE WHEN COALESCE(f.tier, 'warm') = 'warm' THEN 1 ELSE 0 END) AS warm,
         SUM(CASE WHEN COALESCE(f.tier, 'warm') = 'structural' THEN 1 ELSE 0 END) AS structural,
         SUM(CASE WHEN COALESCE(f.tier, 'warm') = 'cold' THEN 1 ELSE 0 END) AS cold,
         SUM(CASE WHEN COALESCE(f.tier, 'warm') NOT IN ('hot', 'warm', 'structural', 'cold') THEN 1 ELSE 0 END) AS unknown
       FROM facts f
       WHERE f.superseded_at IS NULL
         AND (f.expires_at IS NULL OR f.expires_at > ?)
         AND length(f.text) >= ?
         AND f.entity_enrichment_at IS NULL`,
    )
    .get(nowSec, minTextLen) as
    | {
        total: number | null;
        hot: number | null;
        warm: number | null;
        structural: number | null;
        cold: number | null;
        unknown: number | null;
      }
    | undefined;
  return {
    total: Number(row?.total ?? 0),
    byTier: {
      hot: Number(row?.hot ?? 0),
      warm: Number(row?.warm ?? 0),
      structural: Number(row?.structural ?? 0),
      cold: Number(row?.cold ?? 0),
      unknown: Number(row?.unknown ?? 0),
    },
  };
}

type ProcessedEntityMention<T = void> = {
  label: EntityMentionLabel;
  surfaceText: string;
  normalizedSurface: string;
  confidence: number;
  sourceRow: T;
};

type EntityMentionProcessingResult<T = void> = {
  accepted: Array<ProcessedEntityMention<T>>;
  counters: {
    rowsScanned: number;
    accepted: number;
    rejected: number;
    duplicates: number;
    reclassified: number;
    rejectReasons: Record<string, number>;
  };
};

function processEntityMentionsForFact<
  T extends {
    label: string;
    surface_text: string;
    normalized_surface: string;
    confidence: number;
    start_offset: number;
    end_offset: number;
  },
>(rows: T[]): EntityMentionProcessingResult<T> {
  const acceptedByKey = new Map<string, ProcessedEntityMention<T>>();
  let rowsScanned = 0;
  let accepted = 0;
  let rejected = 0;
  let duplicates = 0;
  const rejectReasons: Record<string, number> = {};

  for (const row of rows) {
    rowsScanned++;
    const canonical = canonicalizeEntityMention({
      label: row.label,
      surfaceText: row.surface_text,
      normalizedSurface: row.normalized_surface,
      confidence: row.confidence,
    });
    if (!canonical.accepted) {
      rejected++;
      countReason(rejectReasons, canonical.reason);
      continue;
    }
    const key = makeEntityMentionKey(canonical.label, canonical.normalizedSurface);
    const existing = acceptedByKey.get(key);
    if (existing) {
      duplicates++;
      if (canonical.confidence > existing.confidence) {
        acceptedByKey.set(key, {
          label: canonical.label,
          surfaceText: canonical.surfaceText,
          normalizedSurface: canonical.normalizedSurface,
          confidence: canonical.confidence,
          sourceRow: row,
        });
      }
    } else {
      acceptedByKey.set(key, {
        label: canonical.label,
        surfaceText: canonical.surfaceText,
        normalizedSurface: canonical.normalizedSurface,
        confidence: canonical.confidence,
        sourceRow: row,
      });
      accepted++;
    }
  }

  const allAccepted = [...acceptedByKey.values()];
  let substringFilteredCount = 0;
  const filteredAccepted = allAccepted.filter((m) => {
    const isSubstring = allAccepted.some(
      (other) =>
        other !== m &&
        other.label === m.label &&
        other.normalizedSurface.length > m.normalizedSurface.length &&
        other.normalizedSurface.includes(m.normalizedSurface) &&
        other.sourceRow.start_offset <= m.sourceRow.start_offset &&
        other.sourceRow.end_offset >= m.sourceRow.end_offset,
    );
    if (isSubstring) {
      substringFilteredCount++;
    }
    return !isSubstring;
  });
  if (substringFilteredCount > 0) {
    rejected += substringFilteredCount;
    rejectReasons.substring = (rejectReasons.substring ?? 0) + substringFilteredCount;
  }
  accepted = filteredAccepted.length;
  const reclassified = filteredAccepted.reduce((count, mention) => {
    const sourceRow = mention.sourceRow;
    if (mention.label !== sourceRow.label || mention.normalizedSurface !== sourceRow.normalized_surface) {
      return count + 1;
    }
    return count;
  }, 0);

  return {
    accepted: filteredAccepted,
    counters: {
      rowsScanned,
      accepted,
      rejected,
      duplicates,
      reclassified,
      rejectReasons,
    },
  };
}

export function auditEntityMentions(db: DatabaseSync, limit: number): EntityMentionsAuditSummary {
  const factIds = db
    .prepare(
      `SELECT fem.fact_id
       FROM fact_entity_mentions fem
       JOIN facts f ON fem.fact_id = f.id
       GROUP BY fem.fact_id
       ORDER BY f.created_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ fact_id: string }>;
  let rowsScanned = 0;
  let accepted = 0;
  let rejected = 0;
  let duplicates = 0;
  let reclassified = 0;
  const rejectReasons: Record<string, number> = {};
  for (const fact of factIds) {
    const rows = db
      .prepare(
        `SELECT id, label, surface_text, normalized_surface, start_offset, end_offset, confidence
         FROM fact_entity_mentions
         WHERE fact_id = ?`,
      )
      .all(fact.fact_id) as Array<{
      id: string;
      label: string;
      surface_text: string;
      normalized_surface: string;
      start_offset: number;
      end_offset: number;
      confidence: number;
    }>;
    const result = processEntityMentionsForFact(rows);
    rowsScanned += result.counters.rowsScanned;
    accepted += result.counters.accepted;
    rejected += result.counters.rejected;
    duplicates += result.counters.duplicates;
    reclassified += result.counters.reclassified;
    for (const [reason, count] of Object.entries(result.counters.rejectReasons)) {
      rejectReasons[reason] = (rejectReasons[reason] ?? 0) + count;
    }
  }
  return {
    factsScanned: factIds.length,
    rowsScanned,
    accepted,
    rejected,
    duplicates,
    reclassified,
    rejectReasons,
  };
}

function rowsSignature(
  rows: Array<{ label: string; normalizedSurface: string; surfaceText: string; confidence: number }>,
): string {
  return JSON.stringify(
    rows
      .map((r) => ({
        label: r.label,
        normalizedSurface: r.normalizedSurface,
        surfaceText: r.surfaceText,
        confidence: Number(r.confidence.toFixed(4)),
      }))
      .sort((a, b) =>
        `${a.label}|${a.normalizedSurface}|${a.surfaceText}|${a.confidence}`.localeCompare(
          `${b.label}|${b.normalizedSurface}|${b.surfaceText}|${b.confidence}`,
        ),
      ),
  );
}

export function cleanupEntityMentions(
  db: DatabaseSync,
  options: { limit: number; apply: boolean },
): EntityMentionsCleanupSummary {
  const limit = Math.max(1, Math.floor(options.limit));
  const factIds = db
    .prepare(
      `SELECT fem.fact_id
       FROM fact_entity_mentions fem
       JOIN facts f ON fem.fact_id = f.id
       GROUP BY fem.fact_id
       ORDER BY f.created_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ fact_id: string }>;

  let rowsScanned = 0;
  let accepted = 0;
  let rejected = 0;
  let duplicates = 0;
  let reclassified = 0;
  let changedFacts = 0;
  let removedRows = 0;
  const rejectReasons: Record<string, number> = {};

  for (const fact of factIds) {
    const rows = db
      .prepare(
        `SELECT label, surface_text, normalized_surface, start_offset, end_offset, confidence, detected_lang, source
         FROM fact_entity_mentions
         WHERE fact_id = ?`,
      )
      .all(fact.fact_id) as Array<{
      label: string;
      surface_text: string;
      normalized_surface: string;
      start_offset: number;
      end_offset: number;
      confidence: number;
      detected_lang: string | null;
      source: string;
    }>;
    const before = rowsSignature(
      rows.map((row) => ({
        label: row.label,
        normalizedSurface: row.normalized_surface,
        surfaceText: row.surface_text,
        confidence: row.confidence,
      })),
    );

    const result = processEntityMentionsForFact(rows);
    rowsScanned += result.counters.rowsScanned;
    accepted += result.counters.accepted;
    rejected += result.counters.rejected;
    duplicates += result.counters.duplicates;
    reclassified += result.counters.reclassified;
    for (const [reason, count] of Object.entries(result.counters.rejectReasons)) {
      rejectReasons[reason] = (rejectReasons[reason] ?? 0) + count;
    }

    const nextRows = result.accepted.map((m) => ({
      label: m.label,
      surfaceText: m.surfaceText,
      normalizedSurface: m.normalizedSurface,
      startOffset: m.sourceRow.start_offset,
      endOffset: m.sourceRow.end_offset,
      confidence: m.confidence,
      detectedLang: m.sourceRow.detected_lang,
      source: m.sourceRow.source,
    }));

    const after = rowsSignature(
      nextRows.map((row) => ({
        label: row.label,
        normalizedSurface: row.normalizedSurface,
        surfaceText: row.surfaceText,
        confidence: row.confidence,
      })),
    );
    if (before !== after || rows.length !== nextRows.length) {
      changedFacts++;
      removedRows += Math.max(0, rows.length - nextRows.length);
      if (options.apply) {
        replaceFactEntityMentions(db, fact.fact_id, nextRows, { preserveEnrichmentTimestamp: true });
        if (nextRows.length === 0) {
          db.prepare("UPDATE facts SET entity_enrichment_at = NULL WHERE id = ?").run(fact.fact_id);
        }
      }
    }
  }

  return {
    factsScanned: factIds.length,
    rowsScanned,
    accepted,
    rejected,
    duplicates,
    reclassified,
    rejectReasons,
    changedFacts,
    removedRows,
  };
}

/**
 * Link facts.entity string to contacts/organizations FK columns when resolvable (#1802).
 */
export function resolveEntityForeignKeys(db: DatabaseSync, factId: string, entity: string | null | undefined): void {
  if (!entity?.trim()) return;
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "entity_contact_id") && !cols.some((c) => c.name === "entity_organization_id")) {
    return;
  }

  const key = normalizeEntityKey(entity);
  if (!key) return;

  const existing = db
    .prepare(`SELECT entity, entity_contact_id, entity_organization_id FROM facts WHERE id = ?`)
    .get(factId) as
    | { entity: string | null; entity_contact_id: string | null; entity_organization_id: string | null }
    | undefined;
  if (!existing) return;

  const existingKey = normalizeEntityKey(existing.entity ?? "");
  const hasResolvedFk = existing.entity_contact_id != null || existing.entity_organization_id != null;
  if (hasResolvedFk && existingKey === key) return;

  let contactId: string | null = null;
  let organizationId: string | null = null;

  const contact = db
    .prepare(`SELECT id FROM contacts WHERE normalized_key = ? OR lower(display_name) = lower(?) LIMIT 1`)
    .get(key, entity.trim()) as { id: string } | undefined;
  if (contact) contactId = contact.id;

  const org = db
    .prepare(`SELECT id FROM organizations WHERE canonical_key = ? OR lower(display_name) = lower(?) LIMIT 1`)
    .get(key, entity.trim()) as { id: string } | undefined;
  if (org) organizationId = org.id;

  if (!contactId && !organizationId) {
    const mention = db
      .prepare(
        `SELECT contact_id, organization_id FROM fact_entity_mentions
           WHERE fact_id = ? AND normalized_surface = ?
           ORDER BY confidence DESC LIMIT 1`,
      )
      .get(factId, key) as { contact_id: string | null; organization_id: string | null } | undefined;
    if (mention) {
      contactId = mention.contact_id;
      organizationId = mention.organization_id;
    }
  }

  if (!contactId && !organizationId) return;

  db.prepare(`UPDATE facts SET entity_contact_id = ?, entity_organization_id = ? WHERE id = ?`).run(
    contactId,
    organizationId,
    factId,
  );
}
