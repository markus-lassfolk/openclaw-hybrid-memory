export type ExtractedAuditHealthJson =
  | { kind: "ok"; value: Record<string, unknown> }
  | { kind: "not_found" }
  | { kind: "parse_error" };

export function extractAuditHealthJsonFromLog(logContent: string): ExtractedAuditHealthJson {
  // Attempt to locate the audit-health JSON payload in a mixed cron log. We avoid regex-only
  // extraction because nested JSON contains braces and newlines.
  const candidates = scanJsonObjects(logContent);
  const likelyAuditHealth = /"schemaVersion"\s*:\s*1/.test(logContent) && /"activeFacts"\s*:/.test(logContent);
  if (candidates.length === 0) return likelyAuditHealth ? { kind: "parse_error" } : { kind: "not_found" };

  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (isAuditHealthReport(parsed)) return { kind: "ok", value: parsed };
    } catch {
      // Keep scanning; a later JSON block might be the actual audit-health payload.
    }
  }

  return likelyAuditHealth ? { kind: "parse_error" } : { kind: "not_found" };
}

function isAuditHealthReport(value: unknown): value is Record<string, unknown> {
  return (
    value != null &&
    typeof value === "object" &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
    typeof (value as { activeFacts?: unknown }).activeFacts === "number" &&
    Array.isArray((value as { warnings?: unknown }).warnings) &&
    Array.isArray((value as { errors?: unknown }).errors)
  );
}

function scanJsonObjects(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const end = findJsonObjectEnd(text, i);
    if (end == null) continue;
    out.push(text.slice(i, end + 1));
    i = end;
  }
  return out;
}

function findJsonObjectEnd(text: string, startIdx: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return null;
    }
  }
  return null;
}
