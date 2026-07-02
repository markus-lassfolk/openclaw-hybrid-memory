/**
 * Lightweight regex-based extraction of contact profile hints (email/phone/role/board status)
 * from fact text, for structured contact profile enrichment (issue #2014).
 *
 * Deliberately simple v1 heuristics — not an NLP title parser. Extends the email/phone patterns
 * already used by extractStructuredFields() (services/fact-extraction.ts) with a role/board
 * keyword scan (English + Swedish, since the reporting deployment is multilingual sv/en/no).
 */

const ROLE_KEYWORDS = [
  "chief executive officer",
  "chief technology officer",
  "chief financial officer",
  "chief operating officer",
  "managing director",
  "vice president",
  "co-founder",
  "chairperson",
  "chairwoman",
  "chairman",
  "president",
  "founder",
  "director",
  "manager",
  "advisor",
  "consultant",
  "sverigechef",
  "landschef",
  "ordförande",
  "styrelseledamot",
  "styrelsemedlem",
  "board member",
  "vd",
  "ceo",
  "cto",
  "cfo",
  "coo",
  "vp",
  "chair",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Longest-first so e.g. "chief executive officer" matches before the bare "chief" fragments.
const ROLE_KEYWORD_PATTERN = new RegExp(
  `\\b(${[...ROLE_KEYWORDS].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})\\b`,
  "i",
);

const BOARD_KEYWORD_PATTERN =
  /\b(board member|styrelseledamot|styrelsemedlem|chairman|chairwoman|chairperson|chair|ordförande)\b/i;

export type ContactProfileHints = {
  email: string | null;
  phone: string | null;
  /** Matched title, plus up to 3 trailing capitalized words (often an org name), e.g. "Sverigechef Avoki". */
  role: string | null;
  boardStatus: "board" | "management" | null;
};

/** Extract email/phone/role/board-status hints from free text. Returns nulls when nothing matches. */
export function parseContactProfileHints(text: string): ContactProfileHints {
  const emailMatch = text.match(/([\w.-]+@[\w.-]+\.\w+)/);
  const email = emailMatch ? emailMatch[1] : null;

  const phoneMatch = text.match(/(\+?\d[\d .\-()]{7,}\d)/);
  const phoneDigitCount = phoneMatch ? phoneMatch[1].replace(/\D/g, "").length : 0;
  const phone = phoneMatch && phoneDigitCount >= 8 ? phoneMatch[1].trim() : null;

  const roleMatch = ROLE_KEYWORD_PATTERN.exec(text);
  let role: string | null = null;
  if (roleMatch) {
    const afterKeyword = text.slice(roleMatch.index + roleMatch[0].length);
    // No trailing "." in the word class: avoids swallowing a sentence-ending period into the
    // captured org name (e.g. "CEO of Example Corp." -> "CEO of Example Corp", not "...Corp.").
    const trailing = afterKeyword.match(/^\s+(?:of|at|@)?\s*(\p{Lu}[\p{L}\d&-]*(?:\s+\p{Lu}[\p{L}\d&-]*){0,2})/u);
    role = trailing ? `${roleMatch[0]} ${trailing[1]}`.trim() : roleMatch[0].trim();
  }

  const boardStatus: ContactProfileHints["boardStatus"] = BOARD_KEYWORD_PATTERN.test(text)
    ? "board"
    : roleMatch
      ? "management"
      : null;

  return { email, phone, role, boardStatus };
}
