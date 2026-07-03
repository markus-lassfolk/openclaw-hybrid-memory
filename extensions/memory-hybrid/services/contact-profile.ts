/**
 * Structured contact profile enrichment (#2014).
 * Propagates email/phone/role from facts and CONTACTS.md imports into the contacts table.
 */

import { readFileSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  findContactIdByNameQuery,
  getContactById,
  mergeContactProfileFields,
  normalizeEntityKey,
  resolveContactForUpsert,
  upsertOrganization,
  type ContactProfileMergeInput,
  type ContactRow,
  type ProfileUpdatedBy,
} from "../backends/facts-db/entity-layer.js";
import { extractStructuredFields } from "./fact-extraction.js";

export type ContactProfileFields = {
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  role?: string | null;
  boardStatus?: string | null;
  notes?: string | null;
  displayName?: string | null;
  primaryOrgId?: string | null;
};

export type ParsedContactLine = {
  displayName: string;
  email?: string;
  phone?: string;
  role?: string;
  boardStatus?: string;
};

export type ParsedContactsSection = {
  organization: string;
  boardStatus?: string;
  contacts: ParsedContactLine[];
};

export type ContactsImportResult = {
  organizationsUpserted: number;
  contactsUpserted: number;
  factsStored: number;
  orgLinksCreated: number;
  partOfLinksCreated: number;
  dryRun: boolean;
};

const EMAIL_RE = /[\w.+-]+@[\w.-]+\.\w+/;
const PHONE_RE = /(?:\+?\d[\d\s().-]{8,}\d)/;

const ROLE_PATTERNS: RegExp[] = [
  /\b(?:is|as|role:?|title:?|position:?)\s+([A-ZÅÄÖ][\p{L}\p{M}\s./-]{2,60})/iu,
  /\b(Sverigechef|VD|CEO|CTO|CFO|COO|CMO|board member|styrelseledamot|ordförande|vice ordförande)\b/i,
];

const BOARD_SECTION_KEYS = new Set(["board", "styrelse", "board of directors"]);
const MANAGEMENT_SECTION_KEYS = new Set(["management", "ledning", "executive", "leadership"]);

function normalizeBoardSection(heading: string): string | undefined {
  const key = heading.trim().toLowerCase();
  if (BOARD_SECTION_KEYS.has(key)) return "board";
  if (MANAGEMENT_SECTION_KEYS.has(key)) return "management";
  return undefined;
}

function parseContactListLine(line: string, boardStatus?: string): ParsedContactLine | null {
  const trimmed = line.replace(/^[-*•]\s*/, "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const emailMatch = trimmed.match(EMAIL_RE);
  const email = emailMatch?.[0] ?? undefined;
  let rest = trimmed;
  if (email) rest = rest.replace(email, "").trim();

  const phoneMatch = rest.match(PHONE_RE);
  const phone = phoneMatch?.[0]?.replace(/\s+/g, " ").trim();
  if (phone) rest = rest.replace(phoneMatch![0], "").trim();

  rest = rest.replace(/^[\s|/–—-]+|[\s|/–—-]+$/g, "").trim();
  const parts = rest
    .split(/\s*[|/–—]\s*/)
    .map((p) => p.trim())
    .filter(Boolean);

  let displayName = parts[0] ?? rest;
  let role = parts.slice(1).join(" — ") || undefined;
  if (!displayName) return null;

  displayName = displayName.replace(/^\((.+)\)$/, "$1").trim();
  if (!role) {
    const parenRole = trimmed.match(/\(([^)]+)\)\s*$/);
    if (parenRole && !EMAIL_RE.test(parenRole[1])) role = parenRole[1].trim();
  }

  return {
    displayName,
    email,
    phone,
    role: role || undefined,
    boardStatus,
  };
}

/** Parse a markdown CONTACTS roster into org sections and contact lines. */
export function parseContactsMarkdown(content: string): ParsedContactsSection[] {
  const sections: ParsedContactsSection[] = [];
  let currentOrg = "Unknown";
  let currentBoardStatus: string | undefined;
  let currentContacts: ParsedContactLine[] = [];

  const flush = (): void => {
    if (currentContacts.length === 0) return;
    sections.push({
      organization: currentOrg,
      boardStatus: currentBoardStatus,
      contacts: currentContacts,
    });
    currentContacts = [];
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      if (level === 1) {
        flush();
        currentOrg = title;
        currentBoardStatus = undefined;
        continue;
      }
      const board = normalizeBoardSection(title);
      if (board) {
        flush();
        currentBoardStatus = board;
        continue;
      }
    }

    if (/^[-*•]\s+/.test(line)) {
      const parsed = parseContactListLine(line, currentBoardStatus);
      if (parsed) currentContacts.push(parsed);
    }
  }
  flush();
  return sections;
}

export function extractContactProfileFromText(
  text: string,
  entityHint?: string | null,
): ContactProfileFields {
  const fields: ContactProfileFields = {};
  const structured = extractStructuredFields(text, "entity");
  const entity = entityHint?.trim() || structured.entity;

  if (structured.key === "email" && structured.value) {
    fields.email = structured.value;
  } else {
    const emailMatch = text.match(EMAIL_RE);
    if (emailMatch) fields.email = emailMatch[0];
  }

  if (structured.key === "phone" && structured.value) {
    fields.phone = structured.value;
  } else {
    const phoneMatch = text.match(PHONE_RE);
    if (phoneMatch) fields.phone = phoneMatch[0].replace(/\s+/g, " ").trim();
  }

  for (const pattern of ROLE_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      fields.role = match[1].trim().slice(0, 120);
      break;
    }
    if (match?.[0] && !match[1]) {
      fields.role = match[0].trim().slice(0, 120);
      break;
    }
  }

  if (/\bboard member\b/i.test(text) || /\bstyrelseledamot\b/i.test(text)) {
    fields.boardStatus = "board";
  }

  if (entity && !isEntityStopWordLike(entity)) {
    fields.displayName = entity;
  }

  return fields;
}

function isEntityStopWordLike(value: string): boolean {
  const key = normalizeEntityKey(value);
  return key === "user" || key === "decision" || key === "convention" || key === "entity";
}

function findContactByEntityOrMention(
  db: DatabaseSync,
  factId: string,
  entity: string | null | undefined,
  text: string,
): ContactRow | null {
  const candidates: string[] = [];
  if (entity?.trim()) candidates.push(entity.trim());

  const structured = extractStructuredFields(text, "entity");
  if (structured.entity && !isEntityStopWordLike(structured.entity)) {
    candidates.push(structured.entity);
  }

  const properNouns = text.match(/\b[\p{Lu}][\p{L}\p{M}]+(?:\s+[\p{Lu}][\p{L}\p{M}]+)+\b/gu);
  if (properNouns) {
    for (const name of properNouns.slice(0, 3)) candidates.push(name);
  }

  for (const name of candidates) {
    const contactId = findContactIdByNameQuery(db, name);
    if (contactId) return getContactById(db, contactId);
  }

  const mention = db
    .prepare(
      `SELECT fem.contact_id AS id FROM fact_entity_mentions fem
       WHERE fem.fact_id = ? AND fem.label = 'PERSON' AND fem.contact_id IS NOT NULL
       ORDER BY fem.confidence DESC
       LIMIT 1`,
    )
    .get(factId) as { id: string } | undefined;
  return mention?.id ? getContactById(db, mention.id) : null;
}

export type EnrichContactProfileOptions = {
  enabled?: boolean;
  updatedBy?: ProfileUpdatedBy;
  supersede?: boolean;
};

/** Merge parsed profile fields into a matched contact after fact store. */
export function enrichContactProfileFromStoredFact(
  db: DatabaseSync,
  factId: string,
  fact: { text: string; entity: string | null; key: string | null; value: string | null },
  options: EnrichContactProfileOptions = {},
): { contactId: string | null; updated: boolean } {
  if (options.enabled === false) return { contactId: null, updated: false };

  const profile = extractContactProfileFromText(fact.text, fact.entity);
  const hasStructuredContactField =
    profile.email != null ||
    profile.phone != null ||
    profile.role != null ||
    profile.boardStatus != null ||
    fact.key === "email" ||
    fact.key === "phone";

  if (!hasStructuredContactField && !profile.displayName) {
    return { contactId: null, updated: false };
  }

  if (fact.key === "email" && fact.value) profile.email = fact.value;
  if (fact.key === "phone" && fact.value) profile.phone = fact.value;

  let contact = findContactByEntityOrMention(db, factId, fact.entity, fact.text);
  if (!contact && profile.displayName && fact.entity?.trim()) {
    const resolved = resolveContactForUpsert(db, profile.displayName, null, {
      requireSurname: false,
      allowPrefixMatch: true,
    });
    if (resolved.contactId) {
      contact = getContactById(db, resolved.contactId);
    } else if (!resolved.skipped) {
      const created = resolveContactForUpsert(db, profile.displayName, null, {
        requireSurname: false,
        allowPrefixMatch: false,
      });
      if (created.contactId) contact = getContactById(db, created.contactId);
    }
  }

  if (!contact) return { contactId: null, updated: false };

  const mergeInput: ContactProfileMergeInput = {
    email: profile.email ?? null,
    phone: profile.phone ?? null,
    mobile: profile.mobile ?? null,
    role: profile.role ?? null,
    boardStatus: profile.boardStatus ?? null,
    notes: profile.notes ?? null,
    displayName: profile.displayName ?? null,
    primaryOrgId: profile.primaryOrgId ?? null,
    profileSource: "fact_store",
    profileUpdatedBy: options.updatedBy ?? "fact_store",
    supersede: options.supersede === true,
  };

  const updated = mergeContactProfileFields(db, contact.id, mergeInput);
  return { contactId: contact.id, updated };
}

export function readContactsFileMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export function parseContactsFile(path: string): ParsedContactsSection[] {
  const content = readFileSync(path, "utf8");
  return parseContactsMarkdown(content);
}

export type RunContactsImportDeps = {
  storeFact: (input: {
    text: string;
    entity: string | null;
    category: string;
    source: string;
    importance: number;
  }) => { id: string };
  createLink?: (sourceId: string, targetId: string, linkType: "PART_OF", strength?: number) => string;
};

/** Upsert orgs/contacts and roster facts from parsed CONTACTS.md sections. */
export function runContactsImport(
  db: DatabaseSync,
  sections: ParsedContactsSection[],
  deps: RunContactsImportDeps,
  options: { dryRun?: boolean; linkPartOf?: boolean } = {},
): ContactsImportResult {
  const result: ContactsImportResult = {
    organizationsUpserted: 0,
    contactsUpserted: 0,
    factsStored: 0,
    orgLinksCreated: 0,
    partOfLinksCreated: 0,
    dryRun: options.dryRun === true,
  };

  for (const section of sections) {
    result.organizationsUpserted++;
    result.contactsUpserted += section.contacts.length;
    result.factsStored += 1 + section.contacts.length;
    if (options.linkPartOf !== false) {
      result.partOfLinksCreated += section.contacts.length;
    }
    result.orgLinksCreated++;
  }

  if (options.dryRun) return result;

  const now = Math.floor(Date.now() / 1000);
  const insOrgLink = db.prepare(
    `INSERT OR IGNORE INTO org_fact_links (org_id, fact_id, reason, created_at) VALUES (?, ?, 'contacts_import', ?)`,
  );

  for (const section of sections) {
    const org = upsertOrganization(db, section.organization);

    const rosterParts = section.contacts.map((c) => {
      const bits = [c.displayName];
      if (c.email) bits.push(c.email);
      if (c.role) bits.push(c.role);
      return bits.join(" — ");
    });
    const rosterText = `${section.organization} contacts: ${rosterParts.join("; ")}`;
    const rosterFact = deps.storeFact({
      text: rosterText,
      entity: section.organization,
      category: "entity",
      source: "contacts-import",
      importance: 0.85,
    });

    if (org) {
      insOrgLink.run(org.id, rosterFact.id, now);
    }

    for (const contact of section.contacts) {
      const resolved = resolveContactForUpsert(db, contact.displayName, org?.id ?? null, {
        requireSurname: false,
        allowPrefixMatch: true,
      });
      if (!resolved.contactId) continue;

      mergeContactProfileFields(db, resolved.contactId, {
        email: contact.email ?? null,
        phone: contact.phone ?? null,
        role: contact.role ?? null,
        boardStatus: contact.boardStatus ?? section.boardStatus ?? null,
        primaryOrgId: org?.id ?? null,
        displayName: contact.displayName,
        profileSource: "contacts_import",
        profileUpdatedBy: "import",
        supersede: true,
      });

      const personText = [contact.displayName, contact.email, contact.role].filter(Boolean).join(" — ");
      const personFact = deps.storeFact({
        text: personText,
        entity: contact.displayName,
        category: "entity",
        source: "contacts-import",
        importance: 0.8,
      });

      if (options.linkPartOf !== false && deps.createLink) {
        deps.createLink(personFact.id, rosterFact.id, "PART_OF", 1.0);
      }
    }
  }

  return result;
}
