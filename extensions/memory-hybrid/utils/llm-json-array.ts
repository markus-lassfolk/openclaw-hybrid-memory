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
 * Remove common model "thinking" wrappers that appear before JSON (#1718).
 * Handles <thinking>, <redacted_thinking>, and <reasoning> blocks emitted by
 * models such as MiniMax M2.7-highspeed before the actual JSON payload.
 */
export function stripThinkingWrapperBlocks(s: string): string {
  return s
    .replace(/<redacted_thinking>[\s\S]*?<\/redacted_thinking>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .trim();
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
 *
 * @param raw - The raw string to parse
 * @param filter - Optional filter callback to validate parsed arrays; receives the parsed array
 *                 and should return the array to accept or null/undefined to continue searching.
 *                 When provided, the function returns the first array accepted by the filter.
 */
export function tryParseFirstJsonArray(
  raw: string,
  filter?: (parsed: unknown[]) => unknown[] | null | undefined,
): unknown[] | null {
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
      if (Array.isArray(parsed)) {
        if (filter) {
          const result = filter(parsed);
          if (result !== null && result !== undefined) return result;
        } else {
          return parsed;
        }
      }
    } catch {
      /* try next [ — skip this whole balanced span (avoids O(n) single-char steps on long junk) */
    }
    searchFrom = start + slice.length;
  }
  return null;
}

/** Default envelope keys checked when unwrapping structured LLM object payloads. */
export const DEFAULT_STRUCTURED_ITEM_ENVELOPE_KEYS = [
  "items",
  "remediations",
  "remediationItems",
  "analysisItems",
  "analysedItems",
  "analyzedItems",
  "results",
  "analysis",
  "analyses",
  "output",
  "data",
  "arguments",
  "proposals",
  "insights",
  "rules",
  "metas",
  "facts",
  "mentions",
  "labels",
  "categories",
  "classifications",
] as const;

/**
 * Parse a JSON string value when the model double-encodes JSON inside a string field.
 */
export function parseJsonValueIfString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/**
 * From `s`, extract the balanced `{` … `}` substring starting at index `start`.
 */
export function extractBalancedObjectSlice(s: string, start: number): string | null {
  if (s[start] !== "{") return null;
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
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Find the first balanced `{...}` in the response that passes the filter callback.
 */
export function tryParseFirstJsonObject(
  raw: string,
  filter: (parsed: unknown) => unknown[] | null | undefined,
): unknown[] | null {
  let searchFrom = 0;
  while (searchFrom < raw.length) {
    const start = raw.indexOf("{", searchFrom);
    if (start === -1) return null;
    const slice = extractBalancedObjectSlice(raw, start);
    if (!slice) {
      searchFrom = start + 1;
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(slice);
      const result = filter(parsed);
      if (result !== null && result !== undefined) return result;
    } catch {
      /* try next { */
    }
    searchFrom = start + slice.length;
  }
  return null;
}

export type ExtractItemArrayOptions = {
  envelopeKeys?: readonly string[];
};

/**
 * Recursively unwrap arrays/objects/tool-call envelopes to find validated items.
 */
export function extractItemArray(
  value: unknown,
  isValidItem: (item: unknown) => boolean,
  opts?: ExtractItemArrayOptions,
): unknown[] | null {
  const envelopeKeys = opts?.envelopeKeys ?? DEFAULT_STRUCTURED_ITEM_ENVELOPE_KEYS;
  const parsed = parseJsonValueIfString(value);

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return parsed;
    if (parsed.every(isValidItem)) return parsed;
    for (const item of parsed) {
      const nested = extractItemArray(item, isValidItem, opts);
      if (nested && nested.length > 0) return nested;
    }
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  if (isValidItem(parsed)) return [parsed];

  const obj = parsed as Record<string, unknown>;
  for (const key of envelopeKeys) {
    if (!(key in obj)) continue;
    const nested = extractItemArray(obj[key], isValidItem, opts);
    if (nested && nested.length > 0) return nested;
  }

  const toolCalls = obj.tool_calls ?? obj.toolCalls;
  const toolResult = extractItemArray(toolCalls, isValidItem, opts);
  if (toolResult && toolResult.length > 0) return toolResult;

  const fn = obj.function;
  if (fn && typeof fn === "object") {
    const args = (fn as Record<string, unknown>).arguments;
    const nested = extractItemArray(args, isValidItem, opts);
    if (nested && nested.length > 0) return nested;
  }

  return null;
}

function tryParseNdjsonItems(raw: string, isValidItem: (item: unknown) => boolean): unknown[] | null {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const items: unknown[] = [];
  for (const line of lines) {
    if (!(line.startsWith("{") || line.startsWith("["))) return null;
    try {
      const parsed: unknown = JSON.parse(line);
      if (Array.isArray(parsed)) {
        if (!parsed.every(isValidItem)) return null;
        items.push(...parsed);
        continue;
      }
      if (!isValidItem(parsed)) return null;
      items.push(parsed);
    } catch {
      return null;
    }
  }
  return items.length > 0 ? items : null;
}

export type ParseStructuredItemsOptions = ExtractItemArrayOptions & {
  /** When true, return [] if the model emitted a valid but empty array. */
  acceptEmptyArray?: boolean;
};

/**
 * Parse structured items from LLM assistant text: JSON arrays, M3 envelopes, NDJSON, single objects.
 */
export function parseStructuredItems(
  raw: string,
  isValidItem: (item: unknown) => boolean,
  opts?: ParseStructuredItemsOptions,
): unknown[] | null {
  let emptyArrayCandidate: unknown[] | null = null;
  const normalized = stripThinkingWrapperBlocks(raw);

  const acceptFromExtracted = (extracted: unknown[] | null): unknown[] | null | undefined => {
    if (extracted === null) return undefined;
    if (extracted.length === 0) {
      if (opts?.acceptEmptyArray) emptyArrayCandidate = extracted;
      return null;
    }
    return extracted;
  };

  const arrayResult = tryParseFirstJsonArray(normalized, (parsed) =>
    acceptFromExtracted(extractItemArray(parsed, isValidItem, opts)),
  );
  if (arrayResult) return arrayResult;

  const objectResult = tryParseFirstJsonObject(normalized, (parsed) =>
    acceptFromExtracted(extractItemArray(parsed, isValidItem, opts)),
  );
  if (objectResult) return objectResult;

  const ndjsonResult = tryParseNdjsonItems(normalized, isValidItem);
  if (ndjsonResult) return ndjsonResult;

  const singleObject = tryParseFirstJsonObject(normalized, (parsed) => {
    if (isValidItem(parsed)) return [parsed];
    return undefined;
  });
  if (singleObject) return singleObject;

  return emptyArrayCandidate;
}
