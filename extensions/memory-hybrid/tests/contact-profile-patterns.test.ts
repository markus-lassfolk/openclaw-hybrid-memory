/**
 * Contact profile hint extraction (issue #2014 acceptance criteria).
 */

import { describe, expect, it } from "vitest";
import { parseContactProfileHints } from "../utils/contact-profile-patterns.js";

describe("parseContactProfileHints", () => {
  it("extracts email and role from the issue's acceptance-criteria example", () => {
    const hints = parseContactProfileHints("Daniel Thunberg email daniel.thunberg@avoki.com Sverigechef Avoki");
    expect(hints.email).toBe("daniel.thunberg@avoki.com");
    expect(hints.role).toBe("Sverigechef Avoki");
    expect(hints.boardStatus).toBe("management");
  });

  it("detects board membership", () => {
    const hints = parseContactProfileHints("Jane Doe is a board member at Acme Corp.");
    expect(hints.boardStatus).toBe("board");
  });

  it("extracts phone numbers", () => {
    const hints = parseContactProfileHints("Call John at +46 70 123 45 67 for details.");
    expect(hints.phone).toBe("+46 70 123 45 67");
  });

  it("returns nulls when nothing matches", () => {
    const hints = parseContactProfileHints("This text has no contact details at all.");
    expect(hints).toEqual({ email: null, phone: null, role: null, boardStatus: null });
  });

  it("recognizes English C-suite titles", () => {
    const hints = parseContactProfileHints("Jane Roe is the CEO of Example Corp.");
    expect(hints.role).toBe("CEO Example Corp");
    expect(hints.boardStatus).toBe("management");
  });

  it("does not attribute a system-sender address to the mentioned person (#2062)", () => {
    const hints = parseContactProfileHints(
      "Jordan Rivers — Notification from noreply@vendor-example.com about a pending signature request.",
    );
    expect(hints.email).toBeNull();
  });

  it("does not attribute either address when 2+ distinct emails appear in the text (#2062)", () => {
    const hints = parseContactProfileHints(
      "Jordan Rivers, cc: ops@other-example.com — jordan.rivers@example.com, Sverigechef Avoki",
    );
    expect(hints.email).toBeNull();
  });
});
