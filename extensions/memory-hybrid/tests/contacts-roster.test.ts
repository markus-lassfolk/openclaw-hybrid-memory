/**
 * CONTACTS.md roster parsing (issue #2014).
 */

import { describe, expect, it } from "vitest";
import { formatContactsRoster, parseContactsRoster } from "../services/contacts-roster.js";

describe("parseContactsRoster", () => {
  it("parses org sections and person rows with optional fields", () => {
    const markdown = `
# Contacts

## Avoki

- Daniel Thunberg | daniel.thunberg@avoki.com | Sverigechef | management
- Jane Doe | jane@avoki.com | | board

## Example Corp

- John Smith | john@example.com | CEO | management
- Jane Roe
`;
    const orgs = parseContactsRoster(markdown);
    expect(orgs).toHaveLength(2);
    expect(orgs[0].name).toBe("Avoki");
    expect(orgs[0].people).toEqual([
      { name: "Daniel Thunberg", email: "daniel.thunberg@avoki.com", role: "Sverigechef", boardStatus: "management" },
      { name: "Jane Doe", email: "jane@avoki.com", role: null, boardStatus: "board" },
    ]);
    expect(orgs[1].name).toBe("Example Corp");
    expect(orgs[1].people).toEqual([
      { name: "John Smith", email: "john@example.com", role: "CEO", boardStatus: "management" },
      { name: "Jane Roe", email: null, role: null, boardStatus: null },
    ]);
  });

  it("ignores comments, blank lines, and bullets outside a section", () => {
    const markdown = `
<!-- top-level comment -->
- Orphan Person | orphan@example.com

## Real Org
- Real Person | real@example.com
`;
    const orgs = parseContactsRoster(markdown);
    expect(orgs).toHaveLength(1);
    expect(orgs[0].people).toHaveLength(1);
    expect(orgs[0].people[0].name).toBe("Real Person");
  });

  it("is case-insensitive for board_status and ignores unknown values", () => {
    const markdown = `
## Org
- A | | | BOARD
- B | | | Management
- C | | | trustee
`;
    const [org] = parseContactsRoster(markdown);
    expect(org.people.map((p) => p.boardStatus)).toEqual(["board", "management", null]);
  });

  it("round-trips through formatContactsRoster", () => {
    const orgs = parseContactsRoster(`
## Avoki
- Daniel Thunberg | daniel.thunberg@avoki.com | Sverigechef | management
`);
    const reparsed = parseContactsRoster(formatContactsRoster(orgs));
    expect(reparsed).toEqual(orgs);
  });
});
