/**
 * CONTACTS.md roster parsing for `hybrid-mem contacts import`/`sync` (issue #2014).
 *
 * Format:
 *   ## Org Name
 *   - Person Name | email | role | board_status
 *
 * `email`, `role`, and `board_status` are optional (leave blank between `|` or omit trailing
 * fields). `board_status` is one of `board` | `management` (case-insensitive); anything else is
 * ignored. Lines outside an `## Org Name` section, blank lines, and `<!-- comments -->` are
 * skipped.
 */

export type RosterPerson = {
  name: string;
  email: string | null;
  role: string | null;
  boardStatus: "board" | "management" | null;
};

export type RosterOrg = {
  name: string;
  people: RosterPerson[];
};

function parseBoardStatus(raw: string | undefined): RosterPerson["boardStatus"] {
  const v = raw?.trim().toLowerCase();
  if (v === "board") return "board";
  if (v === "management") return "management";
  return null;
}

/** Parse a CONTACTS.md-style roster into org sections with their people. */
export function parseContactsRoster(markdown: string): RosterOrg[] {
  const orgs: RosterOrg[] = [];
  let current: RosterOrg | null = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("<!--")) continue;

    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      current = { name: headingMatch[1].trim(), people: [] };
      orgs.push(current);
      continue;
    }
    if (line.startsWith("#")) continue; // top-level title / other heading levels

    const personMatch = line.match(/^[-*]\s+(.+)$/);
    if (personMatch && current) {
      const [name, email, role, boardStatusRaw] = personMatch[1].split("|").map((p) => p.trim());
      if (!name) continue;
      current.people.push({
        name,
        email: email || null,
        role: role || null,
        boardStatus: parseBoardStatus(boardStatusRaw),
      });
    }
  }

  return orgs;
}

/** Drop trailing empty fields (e.g. ["Name", "", "", ""] -> ["Name"]) without a backtracking-prone regex. */
function stripTrailingEmptyFields(fields: string[]): string[] {
  const result = [...fields];
  while (result.length > 0 && result[result.length - 1] === "") {
    result.pop();
  }
  return result;
}

/** Render orgs/people back to the CONTACTS.md format — used by tests and as a starter-file generator. */
export function formatContactsRoster(orgs: RosterOrg[]): string {
  const lines: string[] = [
    '<!-- Format: "## Org Name" starts a section; "- Name | email | role | board_status" lists a person. -->',
    "<!-- email, role, board_status are optional. board_status: board|management. -->",
    "",
  ];
  for (const org of orgs) {
    lines.push(`## ${org.name}`, "");
    for (const p of org.people) {
      const fields = stripTrailingEmptyFields([p.name, p.email ?? "", p.role ?? "", p.boardStatus ?? ""]);
      lines.push(`- ${fields.join(" | ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
