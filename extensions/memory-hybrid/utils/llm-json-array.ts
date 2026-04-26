/**
 * Extract a JSON array from LLM assistant text.
 * Avoids greedy regex `/\[[\s\S]*\]/`, which pairs the first `[` with the *last* `]`
 * and can grab prose plus a real array, or multiple spans, producing JSON.parse errors.
 */

/**
 * If the response is wrapped in a markdown ``` or ```json fence, return inner content; else trim.
 */
export function stripMarkdownCodeFence(raw: string): string {
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1] : raw).trim();
}

/**
 * Strip gateway/model bracket lines like `[Context: …]` that precede real JSON (#1166).
 */
export function stripBracketContextPreamble(raw: string): string {
  let t = raw.trimStart();
  for (let i = 0; i < 8; i++) {
    const m = t.match(/^\[[^\]]*\]\s*/);
    if (!m) break;
    if (!/^\[(?:context|Contexts?):/i.test(m[0])) break;
    t = t.slice(m[0].length).trimStart();
  }
  return t;
}

/**
 * From `s`, extract the balanced `[` … `]` substring starting at index `start` (which must be `[`),
 * respecting double-quoted strings so `]` inside strings does not close the array.
 */
export function extractBalancedArraySlice(s: string, start: number): string | null {
  if (s[start] !== "[") return null;

  let depth = 0;
  let inString = false;
  let afterBackslash = false;

  for (let i = start; i < s.length; i++) {
    const c = s.charAt(i);
    if (inString) {
      if (afterBackslash) {
        afterBackslash = false;
        continue;
      }
      if (c === "\\") {
        afterBackslash = true;
        continue;
      }
      if (c === '"') {
        inString = false;
        continue;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * From text, extract the substring of the first balanced top-level `[` … `]` pair (scan from first `[`).
 * Prefer {@link tryParseFirstJsonArray} when the model may emit a short invalid bracket span before the array.
 */
export function extractFirstJsonArraySubstring(text: string): string | null {
  const s = stripMarkdownCodeFence(text);
  const start = s.indexOf("[");
  if (start === -1) return null;
  return extractBalancedArraySlice(s, start);
}

/**
 * Find the first balanced `[...]` in the response that parses as a JSON array.
 * Skips prose like `[see below]` or `[batch]` that are not valid JSON arrays.
 */
export function tryParseFirstJsonArray(raw: string): unknown[] | null {
  const s = stripBracketContextPreamble(stripMarkdownCodeFence(raw));
  let searchFrom = 0;
  while (searchFrom < s.length) {
    const start = s.indexOf("[", searchFrom);
    if (start === -1) return null;
    const slice = extractBalancedArraySlice(s, start);
    if (!slice) {
      searchFrom = start + 1;
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(slice);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* try next [ — skip this whole balanced span (avoids O(n) single-char steps on long junk) */
    }
    searchFrom = start + slice.length;
  }
  return null;
}
